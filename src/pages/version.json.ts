// Which commit is live — the vault editor polls this to say "Live now" after publishing.
// Workers Builds sets WORKERS_CI_COMMIT_SHA during the build.
export function GET() {
  const commit = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || 'local';
  return new Response(JSON.stringify({ commit, built: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
