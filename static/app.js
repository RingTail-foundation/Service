const SUPABASE_URL = "https://nxipygonwjlxozfsrbsn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lt5n95QnheWul-URwQHtog_XBHya10T";

const RESULTS_PER_PAGE = 10;

const form = document.getElementById("searchForm");
const input = document.getElementById("searchInput");
const results = document.getElementById("results");
const pageCountEl = document.getElementById("pageCount");

let currentPage = 0;
// Guards against an older, slower response overwriting a newer one — type
// "rust", then "rust book", and if the first request resolves second you'd be
// looking at results for a query you no longer have on screen.
let requestId = 0;

function rpc(fn, body) {
    return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
    });
}

/* --------------------------------------------------------------------------
   Rendering
   Everything below builds nodes with createElement/textContent instead of
   assembling an innerHTML string. That is not a style preference: title,
   url and snippet are attacker-controlled text, because they come from
   whatever HTML the crawler happened to fetch. The previous innerHTML
   template interpolated all three directly, so any indexed page whose
   <title> contained a <script> or an onerror attribute got that markup
   executed in the browser of every person who searched. Building nodes and
   setting textContent makes that structurally impossible.
   -------------------------------------------------------------------------- */

const SHIELD_PATH = "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z";

function shieldIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "result__secure");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", SHIELD_PATH);
    svg.appendChild(path);
    return svg;
}

// Only http(s) links are ever rendered. Without this check an indexed
// `javascript:` URL would become a clickable script execution.
function safeHref(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
        return null;
    }
}

function prettyUrl(raw) {
    try {
        const u = new URL(raw);
        const path = u.pathname === "/" ? "" : decodeURI(u.pathname).replace(/\/$/, "");
        return u.host.replace(/^www\./, "") + path;
    } catch {
        return raw;
    }
}

function externalLink(href, text, className) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (className) a.className = className;
    a.target = "_blank";
    // noopener/noreferrer on every outbound result link. noreferrer also
    // stops the destination site from learning what was searched to reach it,
    // which matters rather a lot for a privacy-first engine.
    a.rel = "noopener noreferrer";
    return a;
}

function renderResult(item) {
    const href = safeHref(item.url);
    if (!href) return null;

    const wrap = document.createElement("article");
    wrap.className = "result";

    const urlLine = document.createElement("p");
    urlLine.className = "result__url";
    if (href.startsWith("https:")) urlLine.appendChild(shieldIcon());
    const urlText = document.createElement("span");
    urlText.textContent = prettyUrl(href);
    urlLine.appendChild(urlText);
    wrap.appendChild(urlLine);

    const heading = document.createElement("h2");
    heading.style.margin = "0";
    heading.appendChild(
        externalLink(href, item.title || prettyUrl(href), "result__title")
    );
    wrap.appendChild(heading);

    if (item.snippet) {
        const snippet = document.createElement("p");
        snippet.className = "result__snippet";
        snippet.textContent = item.snippet;
        wrap.appendChild(snippet);
    }

    const sitelinks = Array.isArray(item.sitelinks) ? item.sitelinks : [];
    if (sitelinks.length) {
        const grid = document.createElement("div");
        grid.className = "sitelinks";
        for (const sl of sitelinks) {
            const slHref = safeHref(sl.url);
            if (!slHref) continue;
            const cell = document.createElement("div");
            cell.className = "sitelink";
            cell.appendChild(externalLink(slHref, sl.title || prettyUrl(slHref)));
            const u = document.createElement("span");
            u.className = "sitelink__url";
            u.textContent = prettyUrl(slHref);
            cell.appendChild(u);
            grid.appendChild(cell);
        }
        if (grid.childElementCount) wrap.appendChild(grid);
    }

    return wrap;
}

function renderSkeletons(count = 5) {
    results.replaceChildren();
    for (let i = 0; i < count; i++) {
        const s = document.createElement("div");
        s.className = "skeleton";
        const widths = ["38%", "72%", "94%", "61%"];
        for (const w of widths) {
            const bar = document.createElement("div");
            bar.className = "skeleton__bar";
            bar.style.width = w;
            s.appendChild(bar);
        }
        results.appendChild(s);
    }
}

function renderNotice(title, body) {
    const box = document.createElement("div");
    box.className = "notice";
    const t = document.createElement("p");
    t.className = "notice__title";
    t.textContent = title;
    const b = document.createElement("p");
    b.className = "notice__body";
    b.textContent = body;
    box.append(t, b);
    results.replaceChildren(box);
}

function renderPagination(page, hasNext) {
    const nav = document.createElement("nav");
    nav.className = "pagination";
    nav.setAttribute("aria-label", "Result pages");

    if (page > 0) {
        const prev = document.createElement("button");
        prev.type = "button";
        prev.textContent = "\u2190 Previous";
        prev.onclick = () => search(page - 1);
        nav.appendChild(prev);
    }

    const label = document.createElement("span");
    label.className = "pagination__page";
    label.textContent = `page ${page + 1}`;
    nav.appendChild(label);

    if (hasNext) {
        const next = document.createElement("button");
        next.type = "button";
        next.textContent = "Next \u2192";
        next.onclick = () => search(page + 1);
        nav.appendChild(next);
    }

    results.appendChild(nav);
}

/* --------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

// `updateHistory` is false when we're reacting to a browser back/forward
// navigation (popstate) or restoring state on initial page load — in both of
// those cases the URL already reflects where we are, so pushing a new history
// entry would be wrong (it'd break the back button rather than fix it, by
// inserting a duplicate entry every time the user navigates).
async function search(page = 0, updateHistory = true) {
    const query = input.value.trim();
    if (query === "") return;

    currentPage = page;
    const id = ++requestId;

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

    document.body.classList.add("has-results");
    document.title = `${query} — Service`;
    results.setAttribute("aria-busy", "true");
    renderSkeletons();

    const startedAt = performance.now();

    try {
        const response = await rpc("search_pages", { query, page_num: page });
        if (id !== requestId) return;

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (id !== requestId) return;

        const elapsed = Math.round(performance.now() - startedAt);
        results.setAttribute("aria-busy", "false");

        if (!Array.isArray(data) || data.length === 0) {
            if (page === 0) {
                renderNotice(
                    `No results for “${query}”`,
                    "Service searches its own independent index, so coverage is narrower than a big commercial engine. Try broader or fewer words."
                );
            } else {
                renderNotice("End of results", "There are no more pages for this query.");
                renderPagination(page, false);
            }
            return;
        }

        results.replaceChildren();

        const meta = document.createElement("p");
        meta.className = "results__meta";
        meta.textContent = `${data.length} result${data.length === 1 ? "" : "s"} · ${elapsed} ms · no queries logged to your profile`;
        results.appendChild(meta);

        for (const item of data) {
            const node = renderResult(item);
            if (node) results.appendChild(node);
        }

        renderPagination(page, data.length === RESULTS_PER_PAGE);
    } catch (err) {
        if (id !== requestId) return;
        results.setAttribute("aria-busy", "false");
        renderNotice(
            "Search failed",
            "We couldn't reach the index just now. Check your connection and try again."
        );
        console.error("[Service] search failed:", err);
    }
}

form.addEventListener("submit", (e) => {
    e.preventDefault();
    search(0);
});

// Enter-to-search, but never while a CJK IME is mid-composition: in Chinese,
// Japanese and Korean input, Enter confirms the candidate rather than
// submitting. Safari Desktop reports keyCode 229 instead of setting
// isComposing, so both are checked.
input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    search(0);
});

// Browser back/forward — re-run whatever search the URL now reflects, without
// pushing yet another history entry (popstate fires when navigating through
// existing entries, it doesn't create new ones).
window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const page = parseInt(params.get("page"), 10) || 0;
    if (q) {
        input.value = q;
        search(page, false);
    } else {
        input.value = "";
        requestId++;
        results.replaceChildren();
        document.body.classList.remove("has-results");
        document.title = "Service — privacy-first search";
    }
});

// A bookmarked or shared link (e.g. yoursite.com/?q=service) should run that
// search immediately on load, instead of landing on an empty homepage.
(function restoreFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const page = parseInt(params.get("page"), 10) || 0;
    if (q) {
        input.value = q;
        search(page, false);
    }
})();

// Index size on the homepage. Uses the planner's row estimate rather than a
// count(*), so it costs nothing; failure is silent because an absent counter
// is much better than an error message on an otherwise working homepage.
(async function loadIndexSize() {
    if (!pageCountEl) return;
    try {
        const res = await rpc("indexed_page_count", {});
        if (!res.ok) return;
        const n = await res.json();
        const count = typeof n === "number" ? n : Number(n);
        if (!Number.isFinite(count) || count <= 0) return;
        pageCountEl.textContent = `${count.toLocaleString("en-US")} pages indexed`;
    } catch {
        /* silent */
    }
})();
