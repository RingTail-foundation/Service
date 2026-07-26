// robots.rs
//
// Crawl *permission*, as opposed to crawl *extraction* (that's
// algorithm::extract) or crawl *ranking* (algorithm::rank). Two separate
// mechanisms live here, and they mean different things:
//
//   - robots.txt (Disallow/Allow)  -> "you may not even FETCH this URL"
//   - noindex (header or meta tag) -> "you may fetch this, just don't put
//                                      it in your search index"
//   - nofollow (header or meta tag) -> "you may fetch/index this, just
//                                       don't follow its outbound links"
//
// noindex and nofollow are independent of each other (a page can be
// "noindex, follow" — don't show this page, but do discover what it links
// to) so they're tracked as two separate booleans rather than one.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
// Names checked against a robots.txt group's `User-agent:` line, most
// specific first. Falls back to the `*` group if none of these match.
const BOT_NAMES: &[&str] = &["raptor-search", "raptorbot"];

#[derive(Debug, Clone)]
struct Rule {
    allow: bool,
    pattern: String,
}

#[derive(Debug, Clone, Default)]
struct Group {
    agents: Vec<String>,
    rules: Vec<Rule>,
}

static ROBOTS_CACHE: Lazy<Mutex<HashMap<String, (Vec<Group>, Instant)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// True if `url` is allowed to be fetched per its host's robots.txt.
/// Missing/unreachable robots.txt is treated as "everything allowed"
/// (the standard, conservative-for-the-site-owner default).
pub async fn is_allowed(client: &reqwest::Client, url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return true;
    };
    let Some(host) = parsed.host_str() else {
        return true;
    };
    let host_key = format!("{}://{}", parsed.scheme(), host);
    let groups = get_or_fetch_groups(client, &host_key).await;
    match select_group(&groups) {
        Some(g) => is_path_allowed(g, parsed.path()),
        None => true,
    }
}

async fn get_or_fetch_groups(client: &reqwest::Client, host_key: &str) -> Vec<Group> {
    {
        let cache = ROBOTS_CACHE.lock().await;
        if let Some((groups, fetched_at)) = cache.get(host_key) {
            if fetched_at.elapsed() < CACHE_TTL {
                return groups.clone();
            }
        }
    }

    let robots_url = format!("{}/robots.txt", host_key);
    let groups = match client.get(&robots_url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) => parse_groups(&body),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(), // no robots.txt, or fetch failed -> allow everything
    };

    let mut cache = ROBOTS_CACHE.lock().await;
    cache.insert(host_key.to_string(), (groups.clone(), Instant::now()));
    groups
}

fn parse_groups(text: &str) -> Vec<Group> {
    let mut groups = Vec::new();
    let mut current: Option<Group> = None;
    let mut seen_rule_in_current = false;

    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let val = val.trim();

        match key.as_str() {
            "user-agent" => {
                if current.is_none() || seen_rule_in_current {
                    if let Some(g) = current.take() {
                        groups.push(g);
                    }
                    current = Some(Group::default());
                    seen_rule_in_current = false;
                }
                if let Some(g) = current.as_mut() {
                    g.agents.push(val.to_lowercase());
                }
            }
            "disallow" | "allow" => {
                seen_rule_in_current = true;
                // "Disallow:" with an empty value is conventionally a no-op
                // ("nothing is disallowed"), not a rule that matches every
                // path — if we kept it, the generic longest-match logic
                // below would treat its empty pattern as trivially matching
                // everything with allow=false, inverting its meaning into
                // "block everything." Dropping it here is equivalent: with
                // no rule present, unmatched paths correctly default to
                // allowed.
                if key == "disallow" && val.is_empty() {
                    continue;
                }
                if let Some(g) = current.as_mut() {
                    g.rules.push(Rule { allow: key == "allow", pattern: val.to_string() });
                }
            }
            _ => {} // crawl-delay, sitemap, etc. — not handled yet
        }
    }
    if let Some(g) = current.take() {
        groups.push(g);
    }
    groups
}

fn select_group(groups: &[Group]) -> Option<&Group> {
    for name in BOT_NAMES {
        if let Some(g) = groups.iter().find(|g| g.agents.iter().any(|a| a == name)) {
            return Some(g);
        }
    }
    groups.iter().find(|g| g.agents.iter().any(|a| a == "*"))
}

fn is_path_allowed(group: &Group, path: &str) -> bool {
    // Longest matching pattern wins; ties go to Allow (standard convention).
    let mut best: Option<(usize, bool)> = None;
    for rule in &group.rules {
        if !glob_match(&rule.pattern, path) {
            continue;
        }
        let len = rule.pattern.len();
        best = match best {
            Some((blen, _)) if blen > len => best,
            Some((blen, _)) if blen == len => Some((len, best.unwrap().1 || rule.allow)),
            _ => Some((len, rule.allow)),
        };
    }
    match best {
        Some((_, allow)) => allow,
        None => true,
    }
}

/// Small glob matcher: '*' matches any run of characters, a trailing '$'
/// anchors to end-of-path, and otherwise the pattern only needs to match a
/// *prefix* of the path (standard robots.txt Disallow/Allow semantics).
/// Doesn't handle every corner of Google's extended spec (e.g. escaped
/// '$'/'*' mid-pattern) but covers the common real-world cases.
fn glob_match(rule: &str, path: &str) -> bool {
    let (rule, must_end) = match rule.strip_suffix('$') {
        Some(r) => (r, true),
        None => (rule, false),
    };
    fn helper(rule: &[u8], path: &[u8], must_end: bool) -> bool {
        match rule.split_first() {
            None => !must_end || path.is_empty(),
            Some((b'*', rest)) => {
                for i in 0..=path.len() {
                    if helper(rest, &path[i..], must_end) {
                        return true;
                    }
                }
                false
            }
            Some((c, rest)) => path.first() == Some(c) && helper(rest, &path[1..], must_end),
        }
    }
    helper(rule.as_bytes(), path.as_bytes(), must_end)
}

/// Reads X-Robots-Tag off response headers. Returns (noindex, nofollow).
/// Doesn't try to parse per-bot-name-scoped directives (e.g.
/// "googlebot: noindex") — just checks whether the relevant word appears
/// anywhere in the header value, which covers the common case.
pub fn header_directives(headers: &reqwest::header::HeaderMap) -> (bool, bool) {
    let value = headers
        .get("x-robots-tag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    (value.contains("noindex"), value.contains("nofollow"))
}

/// Reads <meta name="robots" content="..."> (and any other meta tag whose
/// name ends in "bot", e.g. googlebot/bingbot) for noindex/nofollow.
/// Returns (noindex, nofollow).
pub fn meta_directives(document: &scraper::Html) -> (bool, bool) {
    let Ok(sel) = scraper::Selector::parse("meta[name][content]") else {
        return (false, false);
    };
    let mut noindex = false;
    let mut nofollow = false;
    for el in document.select(&sel) {
        let name = el.value().attr("name").unwrap_or("").to_lowercase();
        if name != "robots" && !name.ends_with("bot") {
            continue;
        }
        let content = el.value().attr("content").unwrap_or("").to_lowercase();
        if content.contains("noindex") {
            noindex = true;
        }
        if content.contains("nofollow") {
            nofollow = true;
        }
    }
    (noindex, nofollow)
}

// --- Sitemap discovery ---------------------------------------------------
//
// The actual speed win: instead of discovering a site's pages one link at a
// time via BFS through crawled HTML, a sitemap hands you the (near-)
// complete URL list for a site in one or two requests. Sites commonly
// declare their sitemap location in robots.txt via a `Sitemap:` line; we
// also fall back to the conventional `/sitemap.xml` path if none is
// declared. Sitemap *index* files (which list other sitemaps rather than
// pages directly — common on large sites) are followed recursively up to a
// small depth limit.

const MAX_SITEMAP_DEPTH: u8 = 3;
const MAX_SITEMAP_URLS: usize = 5000;

/// Discovers page URLs for a site via its declared/conventional sitemap(s).
/// Returns an empty Vec if the site has no sitemap or it can't be fetched —
/// callers should treat that as "no bulk discovery available," not an
/// error, and fall back to ordinary link-crawling.
pub async fn discover_sitemap_urls(client: &reqwest::Client, site_url: &str) -> Vec<String> {
    let Ok(parsed) = reqwest::Url::parse(site_url) else {
        return Vec::new();
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    let host_key = format!("{}://{}", parsed.scheme(), host);

    let robots_url = format!("{}/robots.txt", host_key);
    let mut roots: Vec<String> = match client.get(&robots_url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) => extract_sitemap_directives(&body),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    };
    if roots.is_empty() {
        roots.push(format!("{}/sitemap.xml", host_key));
    }

    let mut discovered = Vec::new();
    let mut seen_sitemaps = std::collections::HashSet::new();
    let mut queue: Vec<(String, u8)> = roots.into_iter().map(|s| (s, 0)).collect();

    while let Some((sm_url, depth)) = queue.pop() {
        if discovered.len() >= MAX_SITEMAP_URLS
            || depth > MAX_SITEMAP_DEPTH
            || !seen_sitemaps.insert(sm_url.clone())
        {
            continue;
        }
        let Ok(resp) = client.get(&sm_url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.text().await else {
            continue;
        };

        // A sitemap *index* lists other sitemaps (<sitemapindex><sitemap>
        // <loc>...); a regular sitemap lists pages directly (<urlset><url>
        // <loc>...). Check the actual root element rather than guessing
        // per-URL — much more reliable than heuristics like "ends in .xml".
        let is_index = body.contains("<sitemapindex");
        for loc in extract_loc_tags(&body) {
            if is_index {
                queue.push((loc, depth + 1));
            } else {
                discovered.push(loc);
                if discovered.len() >= MAX_SITEMAP_URLS {
                    break;
                }
            }
        }
    }

    discovered
}

fn extract_sitemap_directives(robots_txt: &str) -> Vec<String> {
    robots_txt
        .lines()
        .filter_map(|line| {
            let line = line.split('#').next().unwrap_or("").trim();
            let (key, val) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("sitemap") {
                Some(val.trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Lightweight <loc>...</loc> extraction — deliberately not a full XML
/// parser dependency, same tradeoff as the JSON-LD "@type" extraction in
/// algorithm::metadata. Sitemap XML is simple enough that this is reliable
/// for the real-world case.
fn extract_loc_tags(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<loc>") {
        rest = &rest[start + 5..];
        let Some(end) = rest.find("</loc>") else { break };
        let url = rest[..end].trim();
        if !url.is_empty() {
            out.push(url.to_string());
        }
        rest = &rest[end + 6..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disallow_blocks_prefix() {
        let groups = parse_groups("User-agent: *\nDisallow: /admin\n");
        let g = select_group(&groups).unwrap();
        assert!(!is_path_allowed(g, "/admin/settings"));
        assert!(is_path_allowed(g, "/public/page"));
    }

    #[test]
    fn allow_overrides_longer_specific_disallow() {
        // Standard robots.txt convention: longest match wins, so a more
        // specific Allow inside a disallowed directory re-permits it.
        let groups = parse_groups("User-agent: *\nDisallow: /private\nAllow: /private/ok\n");
        let g = select_group(&groups).unwrap();
        assert!(is_path_allowed(g, "/private/ok/page"));
        assert!(!is_path_allowed(g, "/private/secret"));
    }

    #[test]
    fn empty_disallow_means_allow_all() {
        let groups = parse_groups("User-agent: *\nDisallow:\n");
        let g = select_group(&groups).unwrap();
        assert!(is_path_allowed(g, "/anything"));
    }

    #[test]
    fn specific_bot_group_overrides_wildcard() {
        let groups = parse_groups(
            "User-agent: *\nDisallow: /\nUser-agent: raptor-search\nDisallow:\n",
        );
        let g = select_group(&groups).unwrap();
        // Should have picked the raptor-search group (empty Disallow), not
        // the wildcard group that blocks everything.
        assert!(is_path_allowed(g, "/anything"));
    }

    #[test]
    fn wildcard_pattern_matches() {
        let groups = parse_groups("User-agent: *\nDisallow: /*.pdf$\n");
        let g = select_group(&groups).unwrap();
        assert!(!is_path_allowed(g, "/files/report.pdf"));
        assert!(is_path_allowed(g, "/files/report.pdf.html"));
    }

    #[test]
    fn detects_meta_noindex() {
        let html = r#"<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>"#;
        let doc = scraper::Html::parse_document(html);
        let (noindex, nofollow) = meta_directives(&doc);
        assert!(noindex);
        assert!(!nofollow);
    }

    #[test]
    fn extracts_sitemap_directive_from_robots_txt() {
        let robots = "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n";
        let sitemaps = extract_sitemap_directives(robots);
        assert_eq!(sitemaps, vec!["https://example.com/sitemap.xml"]);
    }

    #[test]
    fn extracts_loc_tags_from_urlset() {
        let xml = r#"<?xml version="1.0"?><urlset>
            <url><loc>https://example.com/a</loc></url>
            <url><loc>https://example.com/b</loc></url>
        </urlset>"#;
        let locs = extract_loc_tags(xml);
        assert_eq!(locs, vec!["https://example.com/a", "https://example.com/b"]);
    }
}
