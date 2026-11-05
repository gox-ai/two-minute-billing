/** Where the tile under the pointer will land, drawn in its own sortable slot. */
export function DropSlot({ columns, row, start }: { columns: number; row: number; start: number }) {
  const end = start + columns - 1;
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary bg-primary/5 text-primary">
      <span className="text-sm font-medium">Lands here</span>
      <span className="hidden text-xs xl:inline">
        {columns === 1 ? `column ${start}` : `columns ${start} to ${end}`}, row {row}
      </span>
    </div>
  );
}
