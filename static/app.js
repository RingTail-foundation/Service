const SUPABASE_URL = "https://nxipygonwjlxozfsrbsn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lt5n95QnheWul-URwQHtog_XBHya10T";
const PRIVADCY_URL = "https://privadcy.onrender.com";

const input = document.getElementById("searchInput");
const button = document.getElementById("searchButton");
const results = document.getElementById("results");
let currentPage = 0;

// Fetches sub-pool-matched ads for this query. Never lets an ad-network
// hiccup break real search — any failure (network, bad JSON, Privadcy
// asleep on Render's free tier) just means no sponsored block, silently.
async function fetchSponsored(query) {
    try {
        const response = await fetch(
            `${PRIVADCY_URL}/ads/for-query?q=${encodeURIComponent(query)}`
        );
        const data = await response.json();
        return data.sponsored || [];
    } catch (e) {
        console.error("Sponsored results fetch failed:", e);
        return [];
    }
}

// Renders above the organic results, matching Google's placement.
// Reuses the .result class so it inherits your existing result styling;
// add .sponsored-result / .sponsored-heading rules in style.css if you
// want it visually distinguished further.
function renderSponsored(sponsored) {
    if (!sponsored.length) return;
    const heading = document.createElement("p");
    heading.className = "sponsored-heading";
    heading.textContent = "Sponsored";
    results.appendChild(heading);
    for (const ad of sponsored) {
        const div = document.createElement("div");
        div.className = "result sponsored-result";
        div.innerHTML = `
            <a href="${ad.destination_url}" target="_blank" rel="sponsored noopener noreferrer">${ad.description}</a>
            <p class="url">${ad.destination_url}</p>
        `;
        results.appendChild(div);
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

    results.innerHTML = "Searching...";
    try {
        // Run the real search and the ad fetch concurrently — sponsored
        // results should never add latency to organic search.
        const [response, sponsored] = await Promise.all([
            fetch(
                `${SUPABASE_URL}/rest/v1/rpc/search_pages`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "apikey": SUPABASE_ANON_KEY,
                        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
                    },
                    body: JSON.stringify({ query: query, page_num: page })
                }
            ),
            // Only fetch ads for the first page — a "sponsored" block on
            // page 2+ of the same query would just repeat the same ad,
            // since sub-pool matching is deterministic per query text.
            page === 0 ? fetchSponsored(query) : Promise.resolve([])
        ]);
        const data = await response.json();
        results.innerHTML = "";
        renderSponsored(sponsored);
        if (!data.length) {
            const msg = document.createElement("p");
            msg.textContent = page === 0 ? "No results found." : "No more results.";
            results.appendChild(msg);
            return;
        }
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
                                <a href="${sl.url}" target="_blank">${sl.title}</a>
                                <p class="url">${sl.url}</p>
                            </div>
                        `).join("")}
                    </div>
                `;
            }

            div.innerHTML = `
                <a href="${item.url}" target="_blank">${item.title}</a>
                <p class="url">${item.url}</p>
                <p>${item.snippet}</p>
                ${sitelinksHtml}
            `;
            results.appendChild(div);
        }
        const nav = document.createElement("div");
        nav.className = "pagination";
        if (currentPage > 0) {
            const prev = document.createElement("button");
            prev.textContent = "← Previous";
            prev.onclick = () => search(currentPage - 1);
            nav.appendChild(prev);
        }
        if (data.length === 10) {
            const next = document.createElement("button");
            next.textContent = "Next →";
            next.onclick = () => search(currentPage + 1);
            nav.appendChild(next);
        }
        results.appendChild(nav);
    } catch (e) {
        results.innerHTML = "<p>Search failed.</p>";
        console.error(e);
    }
}

button.onclick = () => search(0);
input.addEventListener("keydown", e => {
    if (e.key === "Enter") search(0);
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
