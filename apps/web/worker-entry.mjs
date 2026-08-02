// Custom Worker entrypoint: wraps the OpenNext-generated worker and adds the
// cron triggers, each calling the matching app route.
import worker from "./.open-next/worker.js";
export * from "./.open-next/worker.js";

const handlers = {
  fetch: worker.fetch,
  async scheduled(controller, env, ctx) {
    // "30 3 * * *"    → nightly GSC top-up + detectors
    // "*/5 2-5 * * *" → overnight rank-tracker refresh, one batch per tick
    const path = controller.cron === "30 3 * * *" ? "/api/cron/daily" : "/api/cron/ranks";
    const request = new Request(`https://gsc-reader.seomarketer2011.workers.dev${path}`, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET ?? "" },
    });
    ctx.waitUntil(worker.fetch(request, env, ctx));
  },
};
export default handlers;
