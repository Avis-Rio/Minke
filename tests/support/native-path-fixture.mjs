export const inject = ["sessionController", "webServer"];

/** Replace only the OS launch, retaining the real Remote and Host path verification. */
export function apply(ctx) {
  const openedPaths = [];
  ctx.effect(() => {
    const controller = ctx.sessionController;
    const { openPath, canOpenPath } = controller;
    controller.openPath = async (path, signal) => { signal.throwIfAborted(); openedPaths.push(path); };
    controller.canOpenPath = () => true;
    return () => { controller.openPath = openPath; controller.canOpenPath = canOpenPath; };
  }, "smoke: native file opener");
  ctx.webServer.register({
    kind: "exact", path: "/smoke/opened-paths",
    handler(_request, response) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(openedPaths));
    },
  });
}
