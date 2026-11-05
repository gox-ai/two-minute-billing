// Imported first by the seed: the engine logs every simulated tick at info, which would
// bury the progress lines. Evaluated before `platform/config` reads LOG_LEVEL.
process.env.LOG_LEVEL ??= "error";
