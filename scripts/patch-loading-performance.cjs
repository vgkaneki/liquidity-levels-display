const fs = require('fs');
const file = 'artifacts/api-server/src/app.ts';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker) {
  if (src.includes(marker)) {
    console.log(`[loading-performance-patch] already applied ${marker}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[loading-performance-patch] skipped ${marker}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[loading-performance-patch] applied ${marker}`);
}

apply(
`  pinoHttp({
    logger,
    serializers: {`,
`  pinoHttp({
    logger,
    // loadingPerformanceV1: do not spend server CPU logging every hashed JS/CSS
    // asset request or health probe. API and websocket route logs remain intact.
    autoLogging: {
      ignore: (req) => {
        const url = req.url || "";
        return (
          req.method === "GET" &&
          (url.startsWith("/assets/") ||
            url === "/favicon.ico" ||
            url === "/manifest.webmanifest" ||
            url === "/robots.txt" ||
            url === "/api/healthz" ||
            url === "/api/status")
        );
      },
    },
    serializers: {`,
'loadingPerformanceV1'
);

apply(
`    express.static(staticDir, {
      index: false,
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
      etag: true,
    }),`,
`    express.static(staticDir, {
      index: false,
      // assetCacheV1: hashed Vite assets can be cached aggressively. This
      // reduces repeat-load time and removes avoidable API-server work.
      maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
      immutable: process.env.NODE_ENV === "production",
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        }
      },
    }),`,
'assetCacheV1'
);

apply(
`    res.sendFile(path.join(staticDir, "index.html"));`,
`    // indexNoStoreV1: always revalidate the app shell so deploys update cleanly
    // while hashed assets stay cached for fast repeat loads.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(staticDir, "index.html"));`,
'indexNoStoreV1'
);

fs.writeFileSync(file, src);
console.log('[loading-performance-patch] complete');
