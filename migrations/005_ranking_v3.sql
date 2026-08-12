-- 005_ranking_v3.sql
--
-- Ranking v3. Idempotent (CREATE OR REPLACE throughout) so it is safe to
-- run more than once.
--
-- READ THIS FIRST — it explains why this file exists at all:
--
-- There are two independent search paths in this project and they do NOT
-- share ranking code:
--
--   1. The Rust backend's GET /search, which executes
--      algorithm::rank::SEARCH_SQL against Postgres.
--   2. The Supabase RPC `search_pages`, which is what static/app.js
--      actually calls from the browser.
--
-- Path 2 is what real users hit. Editing src/algorithm/rank.rs alone
-- changes nothing that a visitor to the site can observe. So this migration
-- does two things: it installs the v3 scoring functions, and it redefines
-- `search_pages` to use them, so both paths score identically.
--
-- The rationale for each individual scoring change is documented at length
-- in src/algorithm/rank.rs — that file is the source of truth. Keep the two
-- in sync when changing scoring.

-- ---------------------------------------------------------------------------
-- 1. Scoring helper functions
-- ---------------------------------------------------------------------------

-- Escape LIKE metacharacters in untrusted text. Without this, a query
-- containing % or _ acts as a wildcard inside the boost functions: a bare
-- "%" query would match every title and collect a 2.0x boost.
CREATE OR REPLACE FUNCTION like_escape(t TEXT)
RETURNS TEXT AS $$
    SELECT replace(replace(replace(coalesce(t, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$ LANGUAGE sql IMMUTABLE;

-- Saturating link authority: clamped before the log so a sitewide self-link
-- repeated across a huge site cannot buy unbounded rank.
CREATE OR REPLACE FUNCTION authority_weight(inbound BIGINT)
RETURNS DOUBLE PRECISION AS $$
    SELECT log(2 + least(greatest(coalesce(inbound, 0), 0), 5000)::numeric)::double precision;
$$ LANGUAGE sql IMMUTABLE;

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

    IF replace(replace(bare_host, '-', ''), '.', '') = replace(replace(q, '-', ''), ' ', '') THEN
        RETURN 3.2;
    END IF;

    IF length(q) >= 4 AND host ~ ('(^|[.-])' || regexp_replace(q, '([^a-z0-9])', '\\\1', 'g') || '([.-]|$)') THEN
        RETURN 1.8;
    END IF;

    RETURN 1.0;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

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

-- Host with scheme and leading www. stripped. Used for sitelink grouping so
-- proton.me and www.proton.me are treated as one site.
CREATE OR REPLACE FUNCTION registrable_host(page_url TEXT)
RETURNS TEXT AS $$
    SELECT lower(regexp_replace(coalesce(page_url, ''), '^https?://(www\.)?([^/]+).*$', '\2'));
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- 2. The RPC the browser actually calls
-- ---------------------------------------------------------------------------
--
-- Contract kept identical to what static/app.js already expects, so no
-- frontend change is required for this migration to take effect:
--   args    : query TEXT, page_num INTEGER
--   returns : rows of (title, url, snippet, sitelinks jsonb)
--   ordering: score DESC, 10 primary results per page
--
-- Sitelink grouping is done here in SQL rather than in Rust
-- (algorithm::sitelinks::group_by_domain) because the browser talks to
-- Supabase directly and never runs the Rust grouping code. The two
-- implementations follow the same rule: the highest-scoring page for a
-- domain becomes the primary result, and up to 4 further pages from that
-- same domain nest underneath it instead of occupying their own rows.

DROP FUNCTION IF EXISTS search_pages(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_pages(query TEXT, page_num INTEGER DEFAULT 0)
RETURNS TABLE (
    title TEXT,
    url TEXT,
    snippet TEXT,
    sitelinks JSONB
)
LANGUAGE sql
STABLE
-- Explicit search_path: this function is reachable by anon via PostgREST,
-- so it must not resolve object names through a caller-controlled path.
SET search_path = public, pg_temp
AS $$
WITH q AS (
    SELECT websearch_to_tsquery('english', query) AS tsq
),
-- Deliberately bounded candidate set. Scoring every matching row would mean
-- running eight plpgsql functions across the entire match set just to return
-- ten results; 400 candidates is far more than enough to fill page 0..N of a
-- ten-per-page UI while keeping the query cheap.
scored AS (
    SELECT
        p.title,
        p.url,
        p.snippet,
        registrable_host(p.url) AS host,
        (
            ts_rank_cd(p.search_vector, q.tsq, 33)
            * authority_weight(p.inbound_links)
            * least(
                domain_match_boost(p.url, query)
                * title_match_boost(p.title, query)
                * homepage_boost(p.url)
                * structural_boost(p.is_canonical, p.has_structured_data, p.mobile_friendly)
                * hygiene_boost(p.url, p.is_https, p.url_depth)
                * content_boost(p.content_length, p.heading_count),
                8.0
            )
        )::double precision AS score
    FROM pages p, q
    WHERE p.search_vector @@ q.tsq
    ORDER BY score DESC
    LIMIT 400
),
ranked AS (
    SELECT s.*,
           row_number() OVER (PARTITION BY s.host ORDER BY s.score DESC, s.url) AS rn_in_host
    FROM scored s
),
primaries AS (
    SELECT r.*,
           row_number() OVER (ORDER BY r.score DESC, r.url) AS group_rank
    FROM ranked r
    WHERE r.rn_in_host = 1
)
SELECT
    pr.title,
    pr.url,
    pr.snippet,
    COALESCE(
        (
            SELECT jsonb_agg(
                       jsonb_build_object('title', sl.title, 'url', sl.url)
                       ORDER BY sl.score DESC
                   )
            FROM (
                SELECT r2.title, r2.url, r2.score
                FROM ranked r2
                WHERE r2.host = pr.host
                  AND r2.rn_in_host BETWEEN 2 AND 5
            ) sl
        ),
        '[]'::jsonb
    ) AS sitelinks
FROM primaries pr
WHERE pr.group_rank > COALESCE(page_num, 0) * 10
  AND pr.group_rank <= COALESCE(page_num, 0) * 10 + 10
ORDER BY pr.group_rank;
$$;

-- PostgREST needs the anon role to be able to call this.
GRANT EXECUTE ON FUNCTION search_pages(TEXT, INTEGER) TO anon;

-- ---------------------------------------------------------------------------
-- 3. Index total, for the homepage counter
-- ---------------------------------------------------------------------------
-- reltuples is the planner's estimate, which is effectively free to read.
-- An exact count(*) over a large `pages` table would be a sequential scan on
-- every homepage load, and nobody needs the page count to be exact.
CREATE OR REPLACE FUNCTION indexed_page_count()
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT GREATEST(reltuples::BIGINT, 0) FROM pg_class WHERE relname = 'pages';
$$;

GRANT EXECUTE ON FUNCTION indexed_page_count() TO anon;
