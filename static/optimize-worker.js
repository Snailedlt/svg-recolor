// SVG Recolor: SVGO in a worker (loaded only when "Optimize with SVGO" is on), so a big
// SVG never freezes the page. The ?v= of this file's URL is passed on to SVGO's, so both
// are cached for good and change together.
let svgo = null;
self.onmessage = async (e) => {
    const { id, svg, config } = e.data;
    try {
        if (!svgo) svgo = await import('./vendor/svgo.browser.js' + self.location.search);
        self.postMessage({ id, svg: svgo.optimize(svg, config).data });
    } catch (err) {
        self.postMessage({ id, error: String((err && err.message) || err) });
    }
};
