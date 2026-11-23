"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"

import { Paper, type PaperProps } from "@/components/ui/paper"
import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  children,
  stock = "slip",
  edge,
  tilt = true,
  tape,
  seed,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & Pick<PaperProps, "stock" | "edge" | "tilt" | "tape" | "seed">) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content asChild {...props}>
        <Paper
          data-slot="context-menu-content"
          stock={stock}
          edge={edge}
          tilt={tilt}
          tape={tape}
          rules="none"
          seed={seed}
          className={cn(
            "z-(--ll-z-popover) min-w-32 origin-(--radix-context-menu-content-transform-origin) outline-hidden",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            className
          )}
        >
          <div className="p-1">{children}</div>
        </Paper>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "relative flex min-h-8 w-full cursor-default items-center gap-2 px-2 py-1.5 font-hand text-base outline-hidden select-none",
        "data-[highlighted]:ll-swipe data-[disabled]:pointer-events-none data-[disabled]:text-pencil-text",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1.5 h-px bg-line", className)}
      {...props}
    />
  )
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger }
