"use client";

import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A vertical list the user reorders by drag and drop: the one reorder control in the app.
 * Never add up/down arrow buttons. The grip handle also takes the keyboard: Space to pick
 * up, arrow keys to move, Space to drop.
 */
export function SortableList<T extends string>({
  items,
  onReorder,
  renderItem,
  itemLabel,
  disabled,
  className,
  itemClassName,
}: {
  items: readonly T[];
  onReorder: (next: T[]) => void;
  renderItem: (id: T, index: number) => React.ReactNode;
  /** Names the row for the grip's screen-reader label ("Drag to move Cards"). */
  itemLabel: (id: T) => string;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.indexOf(active.id as T);
    const to = items.indexOf(over.id as T);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove([...items], from, to));
  };
  const label = (id: string) => itemLabel(id as T);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${label(String(active.id))}.`,
          onDragOver: ({ active, over }) =>
            over
              ? `${label(String(active.id))} is at position ${items.indexOf(over.id as T) + 1}.`
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? `${label(String(active.id))} dropped at position ${items.indexOf(over.id as T) + 1}.`
              : `${label(String(active.id))} dropped.`,
          onDragCancel: ({ active }) => `Move of ${label(String(active.id))} cancelled.`,
        },
      }}
    >
      <SortableContext
        items={[...items]}
        strategy={verticalListSortingStrategy}
        disabled={disabled}
      >
        <ul
          className={cn(
            "m-0 flex list-none flex-col divide-y rounded-xl border bg-card p-0",
            className,
          )}
        >
          {items.map((id, i) => (
            <SortableRow
              key={id}
              id={id}
              label={itemLabel(id)}
              disabled={disabled || items.length < 2}
              className={itemClassName}
            >
              {renderItem(id, i)}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  label,
  disabled,
  className,
  children,
}: {
  id: string;
  label: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex items-center gap-2 bg-card first:rounded-t-xl last:rounded-b-xl",
        isDragging && "z-10 rounded-xl shadow-md ring-1 ring-border",
        className,
      )}
    >
      {disabled ? null : (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag to move ${label}`}
          className="touch-target relative flex shrink-0 cursor-grab touch-none items-center rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
    </li>
  );
}
