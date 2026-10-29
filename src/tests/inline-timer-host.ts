// The production host supplies Window timers; these service tests run in Node.
if (typeof window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout, setInterval, clearInterval }
  });
}
