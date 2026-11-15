/**
 * The clock of the test that is running. `setup()` in helpers.ts sets it,
 * and gives it to the app it builds. The workspace objects read it too:
 * the runtime constructs them from the class in main.ts, which a test cannot
 * hand anything to, so what they share with the test is this module.
 */
export const clock = {
  time: new Date(0),
  /** How far Google's clock is behind the app's. */
  googleLagMs: 0,
};
