// -----------------------------------------------------------------------------
// Serial execution: tasks that must never overlap (two eufy clients built at
// once, two state batches checking the rate budget at once...).
// -----------------------------------------------------------------------------

/** Runs the tasks handed to it one after the other, in call order. */
export function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    // A failed task must not block the ones behind it.
    tail = result.catch(() => {});
    return result;
  };
}
