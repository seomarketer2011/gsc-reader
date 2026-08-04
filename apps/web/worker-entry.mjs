// Custom Worker entrypoint: wraps the OpenNext-generated worker and adds the
// cron triggers, each calling the matching app route.
import worker from "./.open-next/worker.js";
export * from "./.open-next/worker.js";

const handlers = {
  fetch: worker.fetch,
  async scheduled(controller, env, ctx) {
    // The only scheduled job left: collect finished rank-tracker tasks. It
    // starts nothing, so no data is refreshed unless you ask for it in the
    // app. /api/cron/daily still exists and can be POSTed by hand with the
    // CRON_SECRET header if a nightly GSC top-up is ever wanted again.
    const request = new Request(`https://gsc-reader.seomarketer2011.workers.dev/api/cron/ranks`, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET ?? "" },
    });
    ctx.waitUntil(worker.fetch(request, env, ctx));
  },
};
export default handlers;
