// middleware.js — place at the project ROOT, same folder as index.html / vercel.json.
// No npm install needed — Vercel auto-detects this file and runs it at the
// edge before serving any page, for any project type (static sites included).

// Two-letter ISO codes. Default is US only. To also allow another country (e.g. you travel to India) WITHOUT
// editing code: in Vercel -> Project -> Settings -> Environment Variables add  ALLOWED_COUNTRIES = US,IN  and redeploy.
const ALLOWED_COUNTRIES = (((typeof process !== 'undefined' && process.env && process.env.ALLOWED_COUNTRIES) || 'US')
  .split(',').map(c => c.trim().toUpperCase()).filter(Boolean));

export const config = {
  // Runs on page requests, skips static assets so CSS/JS/images for an
  // already-allowed visitor don't burn extra invocations re-checking geo.
  matcher: ['/((?!_vercel|favicon.ico|.*\\.(?:css|js|png|jpg|jpeg|svg|ico)$).*)'],
};

export default function middleware(request) {
  // Vercel sets this header on every request at the edge — no package needed to read it.
  const country = request.headers.get('x-vercel-ip-country');

  // Missing country (local dev, some corporate proxies) defaults to allowed,
  // so you don't accidentally lock yourself out while testing.
  if (country && !ALLOWED_COUNTRIES.includes(country)) {
    return new Response('Loading Error, Please try again later or contact support.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  // Allowed — falls through to your static files as normal.
}