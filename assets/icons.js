/* ClayScorer icons — original artwork (clay target + one per discipline), 24×24, drawn in
 * white for the orange header tile. ClayIcons.svg(name, cls) returns inline SVG markup;
 * elements with data-clay-icon="name" are filled in automatically on load. */
(function () {
    'use strict';
    const ICONS = {
        "clay": "<g transform=\"translate(12 13.2) scale(1)\" stroke=\"none\">\n  <path fill=\"white\" d=\"M-9.5 1.6c0-1.6 4.25-2.7 9.5-2.7s9.5 1.1 9.5 2.7c0 1.5-4.25 2.6-9.5 2.6S-9.5 3.1-9.5 1.6Z\"/>\n  <path fill=\"white\" d=\"M-6.3 .2C-5.5-2.6-3.1-3.9 0-3.9s5.5 1.3 6.3 4.1Z\"/>\n  <path fill=\"none\" stroke=\"#f97316\" stroke-width=\"1.1\" stroke-linecap=\"round\" d=\"M-5.9-.7c1.8-.5 3.8-.7 5.9-.7s4.1.2 5.9.7\"/>\n</g>",
        "sporting": "<path d=\"M2.5 20.5c3.2-6.4 7.6-10.3 12.5-11.6\" stroke-dasharray=\"2.2 2.5\"/><g transform=\"translate(17.6 7.6) scale(0.52)\" stroke=\"none\">\n  <path fill=\"white\" d=\"M-9.5 1.6c0-1.6 4.25-2.7 9.5-2.7s9.5 1.1 9.5 2.7c0 1.5-4.25 2.6-9.5 2.6S-9.5 3.1-9.5 1.6Z\"/>\n  <path fill=\"white\" d=\"M-6.3 .2C-5.5-2.6-3.1-3.9 0-3.9s5.5 1.3 6.3 4.1Z\"/>\n  <path fill=\"none\" stroke=\"#f97316\" stroke-width=\"2.1153846153846154\" stroke-linecap=\"round\" d=\"M-5.9-.7c1.8-.5 3.8-.7 5.9-.7s4.1.2 5.9.7\"/>\n</g>",
        "sportrap": "<rect x=\"2\" y=\"16.5\" width=\"7.5\" height=\"5\" rx=\"1.2\" fill=\"white\" stroke=\"none\"/><path d=\"M8.5 15.5c1.9-5.2 5-8.4 8.6-9.7\" stroke-dasharray=\"2.2 2.5\"/><g transform=\"translate(17.8 5.3) scale(0.52)\" stroke=\"none\">\n  <path fill=\"white\" d=\"M-9.5 1.6c0-1.6 4.25-2.7 9.5-2.7s9.5 1.1 9.5 2.7c0 1.5-4.25 2.6-9.5 2.6S-9.5 3.1-9.5 1.6Z\"/>\n  <path fill=\"white\" d=\"M-6.3 .2C-5.5-2.6-3.1-3.9 0-3.9s5.5 1.3 6.3 4.1Z\"/>\n  <path fill=\"none\" stroke=\"#f97316\" stroke-width=\"2.1153846153846154\" stroke-linecap=\"round\" d=\"M-5.9-.7c1.8-.5 3.8-.7 5.9-.7s4.1.2 5.9.7\"/>\n</g>",
        "compak": "<g transform=\"translate(12 8.4) scale(0.72)\" stroke=\"none\">\n  <path fill=\"white\" d=\"M-9.5 1.6c0-1.6 4.25-2.7 9.5-2.7s9.5 1.1 9.5 2.7c0 1.5-4.25 2.6-9.5 2.6S-9.5 3.1-9.5 1.6Z\"/>\n  <path fill=\"white\" d=\"M-6.3 .2C-5.5-2.6-3.1-3.9 0-3.9s5.5 1.3 6.3 4.1Z\"/>\n  <path fill=\"none\" stroke=\"#f97316\" stroke-width=\"1.527777777777778\" stroke-linecap=\"round\" d=\"M-5.9-.7c1.8-.5 3.8-.7 5.9-.7s4.1.2 5.9.7\"/>\n</g><g fill=\"white\" stroke=\"none\"><rect x=\"1.8\" y=\"18\" width=\"3.2\" height=\"3.2\" rx=\".7\"/><rect x=\"6.2\" y=\"18\" width=\"3.2\" height=\"3.2\" rx=\".7\"/><rect x=\"10.4\" y=\"18\" width=\"3.2\" height=\"3.2\" rx=\".7\"/><rect x=\"14.6\" y=\"18\" width=\"3.2\" height=\"3.2\" rx=\".7\"/><rect x=\"19\" y=\"18\" width=\"3.2\" height=\"3.2\" rx=\".7\"/></g>",
        "skeet": "<g fill=\"white\" stroke=\"none\"><rect x=\"1.5\" y=\"2.5\" width=\"4.5\" height=\"19\" rx=\"1\"/><rect x=\"18\" y=\"13.5\" width=\"4.5\" height=\"8\" rx=\"1\"/></g><path d=\"M6.5 5.2c5.2.6 9 3.8 11 8.3\" stroke-dasharray=\"2 2.2\"/><path d=\"M17.5 16.5c-4.8-.6-8.8-3.5-11-8\" stroke-dasharray=\"2 2.2\"/>"
    };
    function svg(name, cls = '') {
        const inner = ICONS[name] || ICONS.clay;
        return `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    }
    function fill(root) {
        (root || document).querySelectorAll('[data-clay-icon]').forEach(el => {
            if (el.dataset.clayIconDone) return;
            el.innerHTML = svg(el.dataset.clayIcon, el.dataset.clayIconClass || 'w-full h-full');
            el.dataset.clayIconDone = '1';
        });
    }
    window.ClayIcons = { svg, fill, names: Object.keys(ICONS) };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fill());
    else fill();
})();
