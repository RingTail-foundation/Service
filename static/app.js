const SUPABASE_URL = "https://nxipygonwjlxozfsrbsn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lt5n95QnheWul-URwQHtog_XBHya10T";

const input = document.getElementById("searchInput");
const button = document.getElementById("searchButton");
const results = document.getElementById("results");
const pageCount = document.getElementById("pageCount");
let currentPage = 0;

const RESULTS_PER_PAGE = 10;

// Values come from crawled third-party pages (titles, snippets, URLs), so they
// are never interpolated into innerHTML without escaping first.
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

// Only http/https may reach an href — a crawled `javascript:` URL would
// otherwise become a script-execution vector on click.
function safeUrl(value) {
    try {
        const parsed = new URL(String(value), window.location.origin);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            ? parsed.href
            : "#";
    } catch {
        return "#";
    }
}

// Strips the scheme and trailing slash so the URL line reads as a breadcrumb
// rather than raw machine output.
function prettyUrl(value) {
    return String(value ?? "")
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
}

async function callRpc(fn, body) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${fn} failed: ${response.status}`);
    return response.json();
}

// `#pageCount` existed in the markup but nothing ever filled it. Showing the
// real index size is the honest version of the pitch: state the scale plainly
// instead of implying Google-scale coverage.
async function loadIndexSize() {
    if (!pageCount) return;
    try {
        const count = await callRpc("get_page_count", {});
        if (typeof count === "number") {
            pageCount.innerHTML =
                `<b>${count.toLocaleString()}</b> pages crawled and indexed &middot; ` +
                `<a href="/live.html">watch it grow</a>`;
        }
    } catch (e) {
        // A failed counter must never block searching — leave the line empty.
        console.error(e);
    }
}

// `updateHistory` is false when we're reacting to a browser back/forward
// navigation (popstate) or restoring state on initial page load — in both
// of those cases the URL already reflects where we are, so pushing a new
// history entry would be wrong (it'd break the back button rather than fix
// it, by inserting a duplicate entry every time the user navigates).
async function search(page = 0, updateHistory = true) {
    const query = input.value.trim();
    if (query === "") return;
    currentPage = page;

    if (updateHistory) {
        const url = new URL(window.location.href);
        url.searchParams.set("q", query);
        if (page > 0) {
            url.searchParams.set("page", page);
        } else {
            url.searchParams.delete("page");
        }
        history.pushState({ query, page }, "", url);
    }

    // Collapses the landing hero into a slim results-page header.
    document.body.classList.add("searching");

    results.innerHTML =
        `<div class="status"><span class="spinner"></span>Searching the index&hellip;</div>`;

    const started = performance.now();

    try {
        const data = await callRpc("search_pages", { query: query, page_num: page });
        const elapsed = ((performance.now() - started) / 1000).toFixed(2);

        results.innerHTML = "";

        if (!data.length) {
            results.innerHTML = page === 0
                ? `<div class="empty">
                       <h2>No results for &ldquo;${escapeHtml(query)}&rdquo;</h2>
                       <p>Our index is independent and still growing, so it has real
                          gaps. Try broader or fewer words.</p>
                   </div>`
                : `<div class="empty">
                       <h2>That&rsquo;s the end of the results</h2>
                       <p>There are no more pages for this query.</p>
                   </div>`;
            if (page > 0) {
                results.appendChild(buildPagination(0));
            }
            return;
        }

        const meta = document.createElement("div");
        meta.className = "results-meta";
        meta.textContent =
            `page ${page + 1} · ${data.length} result${data.length === 1 ? "" : "s"} · ${elapsed}s`;
        results.appendChild(meta);

        for (const item of data) {
            const div = document.createElement("div");
            div.className = "result";

            // sitelinks comes back from search_pages as a jsonb array —
            // empty array when there's nothing else from the same domain
            // worth nesting underneath (see migrations/004_search_pages_rpc.sql).
            let sitelinksHtml = "";
            if (Array.isArray(item.sitelinks) && item.sitelinks.length > 0) {
                sitelinksHtml = `
                    <div class="sitelinks">
                        ${item.sitelinks.map(sl => `
                            <div class="sitelink">
                                <a href="${escapeHtml(safeUrl(sl.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(sl.title)}</a>
                                <p class="url">${escapeHtml(prettyUrl(sl.url))}</p>
                            </div>
                        `).join("")}
                    </div>
                `;
            }

            div.innerHTML = `
                <a href="${escapeHtml(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
                <p class="url">${escapeHtml(prettyUrl(item.url))}</p>
                <p>${escapeHtml(item.snippet)}</p>
                ${sitelinksHtml}
            `;
            results.appendChild(div);
        }

        results.appendChild(buildPagination(page, data.length === RESULTS_PER_PAGE));
    } catch (e) {
        results.innerHTML =
            `<div class="empty">
                 <h2>Search failed</h2>
                 <p>We couldn&rsquo;t reach the index just now. Please try again.</p>
             </div>`;
        console.error(e);
    }
}

function buildPagination(page, hasNext = false) {
    const nav = document.createElement("div");
    nav.className = "pagination";
    if (page > 0) {
        const prev = document.createElement("button");
        prev.textContent = "\u2190 Previous";
        prev.onclick = () => search(page - 1);
        nav.appendChild(prev);
    }
    if (hasNext) {
        const next = document.createElement("button");
        next.textContent = "Next \u2192";
        next.onclick = () => search(page + 1);
        nav.appendChild(next);
    }
    return nav;
}

button.onclick = () => search(0);
input.addEventListener("keydown", e => {
    // Enter also confirms CJK IME composition, so don't submit mid-composition.
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
        search(0);
    }
});

// Browser back/forward — re-run whatever search the URL now reflects,
// without pushing yet another history entry (popstate fires when
// navigating through existing entries, it doesn't create new ones).
window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const page = parseInt(params.get("page"), 10) || 0;
    if (q) {
        input.value = q;
        search(page, false);
    } else {
        input.value = "";
        results.innerHTML = "";
        // Back to the landing view, so restore the full hero.
        document.body.classList.remove("searching");
    }
});

// A bookmarked or shared link (e.g. yoursite.com/?q=service) should run
// that search immediately on load, instead of landing on an empty homepage.
(function restoreFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const page = parseInt(params.get("page"), 10) || 0;
    if (q) {
        input.value = q;
        search(page, false);
    }
})();

loadIndexSize();
