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

function domainFromUrl(url) {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

function setToggleLabel(toggle, expanded) {
    toggle.innerHTML = expanded
        ? 'Hide sponsored results <span class="chevron">&#8964;</span>'
        : 'Show sponsored results <span class="chevron">&#8964;</span>';
}

// Renders a collapsible "Sponsored Results" block above the organic
// results, matching Google's layout: collapsed by default, a pill
// toggle to expand/hide, one card per sponsored ad (icon, site name,
// url, bold headline). Our Ad model has one description field, not
// separate headline/snippet — that single line is used as the headline.
function renderSponsored(sponsored) {
    if (!sponsored.length) return;

    const block = document.createElement("div");
    block.className = "sponsored-block";

    const title = document.createElement("p");
    title.className = "sponsored-title";
    title.textContent = "Sponsored Results";
    block.appendChild(title);

    const divider = document.createElement("hr");
    divider.className = "sponsored-divider";
    block.appendChild(divider);

    const list = document.createElement("div");
    list.className = "sponsored-list"; // collapsed by default, see style.css

    for (const ad of sponsored) {
        const item = document.createElement("div");
        item.className = "sponsored-item";
        item.innerHTML = `
            <div class="sponsored-meta">
                <img class="sponsored-icon" src="${ad.creative_ref}" alt="">
                <span class="sponsored-sitename">${domainFromUrl(ad.destination_url)}</span>
            </div>
            <p class="sponsored-url">${ad.destination_url}</p>
            <a class="sponsored-headline" href="${ad.destination_url}" target="_blank" rel="sponsored noopener noreferrer">${ad.description}</a>
        `;
        list.appendChild(item);
    }
    block.appendChild(list);

    const toggle = document.createElement("button");
    toggle.className = "sponsored-toggle";
    setToggleLabel(toggle, false);
    toggle.onclick = () => {
        const nowExpanded = !list.classList.contains("expanded");
        list.classList.toggle("expanded", nowExpanded);
        toggle.classList.toggle("expanded", nowExpanded);
        setToggleLabel(toggle, nowExpanded);
    };
    block.appendChild(toggle);

    results.appendChild(block);
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

// Voice search — client-side only (Web Speech API), no backend involved.
const micButton = document.getElementById("micButton");
const micError = document.getElementById("micError");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.style.opacity = "0.35";
    micButton.style.cursor = "not-allowed";
} else {
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;

    recognition.onresult = (e) => {
        input.value = e.results[0][0].transcript;
        search(0);
    };
    recognition.onerror = () => {
        micError.hidden = false;
        micButton.classList.remove("listening");
    };
    recognition.onend = () => micButton.classList.remove("listening");

    micButton.onclick = () => {
        micError.hidden = true;
        micButton.classList.add("listening");
        recognition.start();
    };
}
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
