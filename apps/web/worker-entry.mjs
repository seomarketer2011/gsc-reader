// Custom Worker entrypoint: wraps the OpenNext-generated worker and adds the
// nightly cron trigger, which calls the app's own /api/cron/daily route.
import worker from "./.open-next/worker.js";
export * from "./.open-next/worker.js";

const handlers = {
  fetch: worker.fetch,
  async scheduled(controller, env, ctx) {
    const request = new Request("https://gsc-reader.seomarketer2011.workers.dev/api/cron/daily", {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET ?? "" },
    });
    ctx.waitUntil(worker.fetch(request, env, ctx));
  },
};
export default handlers;
