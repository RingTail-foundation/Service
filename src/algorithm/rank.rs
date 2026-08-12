// algorithm/rank.rs
//
// Scoring. History of this file:
//
//   v1: ts_rank(search_vector, query) * log(2 + inbound_links)
//       No notion of "the query IS the name of this site", so a page that
//       mentions a brand once could outrank that brand's own homepage.
//
//   v2: added domain_match_boost / title_match_boost / homepage_boost /
//       structural_boost as multiplicative factors.
//
//   v3 (this version): fixes correctness bugs in the v2 boosts and replaces
//       the relevance core. See the numbered notes below — each one maps to
//       a function in SCORING_FUNCTIONS_SQL.
//
// The v3 changes, in order of how much they affect result quality:
//
//   1. ts_rank -> ts_rank_cd with normalization 33 (= 1|32).
//      ts_rank scores term *frequency*: it rewards a page for repeating a
//      query term, and has no idea whether the terms appear next to each
//      other or 40,000 words apart. ts_rank_cd is cover density ranking —
//      it scores how tightly the query terms cluster, which is much closer
//      to what a person means by "this page is about my query". The
//      normalization bits matter just as much: 1 divides by the log of
//      document length (so a 50-page document stops beating a focused
//      article purely by being long), and 32 maps the result into 0..1.
//      Bounding the relevance core is what makes the multiplicative boosts
//      below behave predictably instead of being swamped by an unbounded
//      base score.
//
//   2. LIKE-injection fix. v2 interpolated the raw user query straight into
//      a LIKE pattern, so a query containing % or _ was silently treated as
//      a wildcard: searching "50%" made `title LIKE '%50%%'` match titles
//      containing just "50", and a query of "%" matched literally every
//      page at boost 2.0. like_escape() neutralizes \ % _ before use.
//
//   3. Word-boundary matching instead of raw substring. v2's
//      `host LIKE '%q%'` fired on any fragment, so a 2-letter query matched
//      almost every domain and handed out a meaningless 1.8x. v3 requires
//      the match to fall on a token boundary and requires >=4 chars before
//      the fuzzy tier applies at all. Same fix for titles, so "art" stops
//      boosting a page titled "Smart Cartography".
//
//   4. Saturating authority. log(2 + inbound_links) grows without limit, so
//      a site with a sitewide footer link repeated across 200k of its own
//      pages could buy rank indefinitely. v3 clamps the count before the
//      log, which keeps the signal but caps what it can win.
//
//   5. A hard cap on combined boost. The v2 factors multiplied out to as
//      much as 4.0 * 2.0 * 1.3 * 1.15 * 1.05 ~= 12.5x, enough for a
//      barely-relevant page to beat a highly relevant one on boosts alone.
//      v3 caps the product at 8.0 so boosts reorder near-ties instead of
//      overriding relevance outright.
//
//   6. Two new signals, both free from columns the crawler already fills:
//      hygiene_boost (https, URL depth, tracking-parameter cruft) and
//      content_boost (thin-content and no-heading penalties).
//
// Every new function is NULL-safe by construction: any row not yet recrawled
// under the current extraction code has NULLs in the structural columns, and
// every CASE here falls through to a neutral 1.0 rather than penalizing a
// page for not having been reprocessed yet.

/// How many index-retrieved candidates get the expensive rerank treatment.
///
/// This is the single most important number in the file for latency. See the
/// two-phase explanation on SEARCH_SQL below.
pub const RERANK_CANDIDATE_POOL: i64 = 1000;

/// Full search query text. Bind order: $1 = raw query string (used for
/// ts_rank_cd + boosts), $2 = limit, $3 = offset, $4 = candidate pool size
/// (pass RERANK_CANDIDATE_POOL).
///
/// The tsquery is computed once in a CTE and joined, rather than being
/// re-parsed in both the SELECT list and the WHERE clause as it was in v2.
///
/// TWO-PHASE RETRIEVAL — why this is shaped like this:
///
/// v2 scored *every* matching row and then sorted. For a common term that
/// matches 200k pages, that means 200k invocations each of six plpgsql
/// functions, several of which run regexes. plpgsql function calls do not
/// inline, so this is ~1.2M interpreted function calls plus regex compiles
/// before a single row is returned — which is exactly how a search query
/// ends up hitting a statement timeout. The cost scales with corpus size,
/// so it gets worse every time the crawler runs.
///
/// So the work is split:
///
///   phase 1 (`candidates`): retrieval. Uses only the GIN index and
///     ts_rank_cd, which is a C function, and takes the top
///     RERANK_CANDIDATE_POOL rows. This is the part whose cost grows with
///     the corpus, so it is kept as cheap as Postgres can make it.
///
///   phase 2 (`SELECT ... FROM candidates`): reranking. The six boost
///     functions run here, against at most RERANK_CANDIDATE_POOL rows
///     instead of every match. Bounded work, so query time stops depending
///     on how many pages happen to contain the word.
///
/// This is the standard retrieve-then-rerank split that every real search
/// engine uses, and it is what makes it affordable to add *more* expensive
/// signals later: anything added to phase 2 costs 1000 evaluations, not
/// however many pages match.
///
/// Correctness note: the boosts can only reorder within the candidate pool,
/// so a page that phase 1 ranks below position 1000 can never be promoted
/// into the results. That is an acceptable and deliberate trade — a page
/// whose cover-density relevance is that far down is not a plausible top
/// result — but it does mean the pool must stay comfortably larger than any
/// offset being served. Guard for that at the call site rather than silently
/// returning a short page.
pub const SEARCH_SQL: &str = r#"
WITH q AS (
    SELECT websearch_to_tsquery('english', $1) AS tsq
),
candidates AS (
    SELECT p.title, p.url, p.snippet, p.inbound_links,
           p.is_canonical, p.has_structured_data, p.mobile_friendly,
           p.is_https, p.url_depth, p.content_length, p.heading_count,
           ts_rank_cd(p.search_vector, q.tsq, 33) AS base_rank
    FROM pages p, q
    WHERE p.search_vector @@ q.tsq
    ORDER BY base_rank DESC
    LIMIT $4
)
SELECT c.title, c.url, c.snippet,
    (
        c.base_rank
        * authority_weight(c.inbound_links)
        * least(
            domain_match_boost(c.url, $1)
            * title_match_boost(c.title, $1)
            * homepage_boost(c.url)
            * structural_boost(c.is_canonical, c.has_structured_data, c.mobile_friendly)
            * hygiene_boost(c.url, c.is_https, c.url_depth)
            * content_boost(c.content_length, c.heading_count),
            8.0
        )
    )::double precision AS score
FROM candidates c
ORDER BY score DESC
LIMIT $2 OFFSET $3
"#;

/// SQL function definitions. Run once via migration — kept here (rather
/// than buried in a .sql file with no comments) so the scoring logic and
/// its rationale live next to each other.
pub const SCORING_FUNCTIONS_SQL: &str = r#"
-- Escape LIKE metacharacters in untrusted text. Without this, a query
-- containing % or _ acts as a wildcard inside every boost function below:
-- a bare "%" query would match every title and collect a 2.0x boost.
CREATE OR REPLACE FUNCTION like_escape(t TEXT)
RETURNS TEXT AS $$
    SELECT replace(replace(replace(coalesce(t, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$ LANGUAGE sql IMMUTABLE;

-- Saturating link authority. Clamped before the log so that a sitewide
-- self-link repeated across a huge site cannot buy unbounded rank; 5000
-- inbound links and 500000 inbound links score the same.
CREATE OR REPLACE FUNCTION authority_weight(inbound BIGINT)
RETURNS DOUBLE PRECISION AS $$
    SELECT log(2 + least(greatest(coalesce(inbound, 0), 0), 5000)::numeric)::double precision;
$$ LANGUAGE sql IMMUTABLE;

-- Boost when the query is essentially the site's own name, e.g. searching
-- "discord" should strongly favor discord.com over pages that merely
-- mention Discord.
--
-- The fuzzy tier requires (a) at least 4 characters of query, and (b) the
-- match to land on a label boundary in the host, so "discord" matches
-- discord.com and app.discord.com but "art" no longer matches
-- smartblog.example.
CREATE OR REPLACE FUNCTION domain_match_boost(page_url TEXT, query TEXT)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    host TEXT;
    bare_host TEXT;
    q TEXT := lower(trim(coalesce(query, '')));
BEGIN
    IF q = '' THEN
        RETURN 1.0;
    END IF;

    host := lower(regexp_replace(coalesce(page_url, ''), '^https?://(www\.)?([^/]+).*$', '\2'));
    bare_host := regexp_replace(host, '\.[a-z]{2,}$', '');

    IF host = q OR bare_host = q THEN
        RETURN 4.0;
    END IF;

    -- Collapse separators so "protonmail" still matches "proton-mail.com".
    IF replace(replace(bare_host, '-', ''), '.', '') = replace(replace(q, '-', ''), ' ', '') THEN
        RETURN 3.2;
    END IF;

    IF length(q) >= 4 AND host ~ ('(^|[.-])' || regexp_replace(q, '([^a-z0-9])', '\\\1', 'g') || '([.-]|$)') THEN
        RETURN 1.8;
    END IF;

    RETURN 1.0;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Boost when the query text appears in the title, extra weight if it's the
-- leading words (how a person actually judges title relevance).
--
-- v3: matches on word boundaries, so "art" no longer boosts "Smart
-- Cartography", and escapes LIKE metacharacters in the prefix test.
CREATE OR REPLACE FUNCTION title_match_boost(page_title TEXT, query TEXT)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    t TEXT := lower(trim(coalesce(page_title, '')));
    q TEXT := lower(trim(coalesce(query, '')));
    q_re TEXT;
BEGIN
    IF q = '' OR t = '' THEN
        RETURN 1.0;
    END IF;

    -- Escape regex metacharacters so the query is matched literally.
    q_re := regexp_replace(q, '([^a-z0-9 ])', '\\\1', 'g');

    IF t LIKE (like_escape(q) || '%') THEN
        RETURN 2.0;
    ELSIF t ~ ('(^|\W)' || q_re || '(\W|$)') THEN
        RETURN 1.4;
    ELSE
        RETURN 1.0;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Mild boost for a site's homepage over a deep subpage, all else equal —
-- when someone searches a brand name they usually want the front door.
CREATE OR REPLACE FUNCTION homepage_boost(page_url TEXT)
RETURNS DOUBLE PRECISION AS $$
BEGIN
    IF coalesce(page_url, '') ~ '^https?://(www\.)?[^/]+/?$' THEN
        RETURN 1.3;
    ELSE
        RETURN 1.0;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Uses the structural columns populated by algorithm::metadata. These are
-- NULL for any row that hasn't been recrawled under the new extraction code
-- yet, so every branch here is written to fall back to a neutral 1.0
-- multiplier on NULL rather than penalizing or erroring on not-yet-processed
-- pages (SQL's `= true`/`= false` comparisons against NULL evaluate to NULL,
-- which falls through to ELSE, not TRUE — that's what makes this safe).
CREATE OR REPLACE FUNCTION structural_boost(
    is_canonical BOOLEAN,
    has_structured_data BOOLEAN,
    mobile_friendly BOOLEAN
)
RETURNS DOUBLE PRECISION AS $$
BEGIN
    RETURN
        (CASE WHEN is_canonical = false THEN 0.7 ELSE 1.0 END)
        * (CASE WHEN has_structured_data = true THEN 1.15 ELSE 1.0 END)
        * (CASE WHEN mobile_friendly = true THEN 1.05 ELSE 1.0 END);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- URL hygiene. Three cheap, honest quality signals:
--   * https: a plain-http page in the current era is usually stale or
--     unmaintained, and on a privacy-first engine it is also a page that
--     leaks its visitors' reading to the network.
--   * depth: /a/b/c/d/e/f is far more often pagination, a faceted filter
--     view, or an archive stub than it is the best answer to a query.
--   * tracking cruft: a URL carrying utm_*, fbclid, gclid or a session id
--     is a syndicated/campaign copy of a canonical page, so prefer the
--     clean original when both are indexed.
CREATE OR REPLACE FUNCTION hygiene_boost(
    page_url TEXT,
    is_https BOOLEAN,
    url_depth INTEGER
)
RETURNS DOUBLE PRECISION AS $$
DECLARE
    u TEXT := lower(coalesce(page_url, ''));
BEGIN
    RETURN
        (CASE WHEN is_https = false THEN 0.75 ELSE 1.0 END)
        * (CASE
              WHEN url_depth IS NULL THEN 1.0
              WHEN url_depth <= 2 THEN 1.0
              WHEN url_depth <= 4 THEN 0.95
              ELSE 0.85
           END)
        * (CASE
              WHEN u ~ '[?&](utm_[a-z]+|fbclid|gclid|mc_eid|sessionid|phpsessid)=' THEN 0.8
              ELSE 1.0
           END);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Content substance. A page with almost no text that nonetheless matches
-- the query is usually a tag page, a login wall, an empty search-results
-- page, or a redirect stub — all things a person did not want. A total
-- absence of headings is a weaker version of the same signal.
--
-- Both columns are NULL on rows crawled before metadata extraction landed,
-- and NULL returns a neutral 1.0 here.
CREATE OR REPLACE FUNCTION content_boost(
    content_length INTEGER,
    heading_count INTEGER
)
RETURNS DOUBLE PRECISION AS $$
BEGIN
    RETURN
        (CASE
              WHEN content_length IS NULL THEN 1.0
              WHEN content_length < 300 THEN 0.6
              WHEN content_length < 800 THEN 0.9
              ELSE 1.0
           END)
        * (CASE WHEN heading_count = 0 THEN 0.9 ELSE 1.0 END);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
"#;
