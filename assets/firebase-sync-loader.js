(function () {
    'use strict';

    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'assets/firebase-sync.js';
    document.body.appendChild(script);
})();
