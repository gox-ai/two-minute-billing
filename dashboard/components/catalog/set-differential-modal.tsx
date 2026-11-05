"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

/**
 * "Set Differential Pricing" picker: a searchable list of the
 * plans this addon/charge applies to. Choosing a plan navigates to the grid for
 * that plan (?plan=). Plans that already carry a differential are tagged so you
 * can tell configured from unconfigured at a glance.
 */
export function SetDifferentialModal({
  plans,
}: {
  plans: Array<{ id: string; name: string; configured: boolean }>;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const pick = (id: string) => {
    setOpen(false);
    router.push(`${pathname}?plan=${encodeURIComponent(id)}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={plans.length === 0}>
          + Set Differential Pricing
        </Button>
      </DialogTrigger>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Set Differential Pricing</DialogTitle>
          <DialogDescription className="sr-only">
            Select a plan to set plan-specific pricing for this item.
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search plans…" />
          <CommandList>
            <CommandEmpty>No plans found.</CommandEmpty>
            <CommandGroup>
              {plans.map((p) => (
                <CommandItem key={p.id} value={p.name} onSelect={() => pick(p.id)}>
                  <span>{p.name}</span>
                  {p.configured ? (
                    <span className="ml-auto text-xs text-muted-foreground">Configured</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
