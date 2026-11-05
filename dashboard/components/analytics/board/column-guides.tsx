/**
 * The twelve tracks a board snaps to, drawn behind the tiles while one is in flight.
 * Only six show below `xl`, because that is how many the grid really has there — guides
 * that disagree with the layout would be a lie drawn in dashes.
 */
export function ColumnGuides() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 hidden gap-6 md:grid md:grid-cols-6 xl:grid-cols-12"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <div
          key={i}
          className={
            "rounded-xl border-x border-dashed border-primary/40 bg-primary/5" +
            (i > 5 ? " hidden xl:block" : "")
          }
        />
      ))}
    </div>
  );
}
