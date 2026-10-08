// Adapted from MIT apps/origin pagination and use-pagination; see third-party/origin-ui.
import type * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, DotsHorizontalIcon } from "@radix-ui/react-icons";
import { cn } from "./utils";
import { buttonVariants } from "./button";

export function paginationItems(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const start = Math.max(2, Math.min(currentPage - 1, totalPages - 3));
  const end = Math.min(totalPages - 1, start + 2);
  return [1, ...(start > 2 ? start === 3 ? [2] : ["ellipsis" as const] : []),
    ...Array.from({ length: end - start + 1 }, (_, i) => start + i),
    ...(end < totalPages - 1 ? end === totalPages - 2 ? [totalPages - 1] : ["ellipsis" as const] : []), totalPages];
}
function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="分页" className={cn("echoink-origin-pagination", className)} data-slot="pagination" {...props} />;
}
function PaginationContent(props: React.ComponentProps<"ul">) { return <ul data-slot="pagination-content" {...props} />; }
function PaginationItem(props: React.ComponentProps<"li">) { return <li data-slot="pagination-item" {...props} />; }
function PaginationLink({ isActive, ...props }: React.ComponentProps<"button"> & { isActive?: boolean }) {
  return <button type="button" aria-current={isActive ? "page" : undefined} className={buttonVariants({ size: "icon", variant: isActive ? "outline" : "ghost" })} data-slot="pagination-link" {...props} />;
}
function PaginationEllipsis() { return <span data-slot="pagination-ellipsis" aria-hidden="true"><DotsHorizontalIcon /></span>; }
export function OriginPagination({ page, pages, onChange, navRef }: { page: number; pages: number; onChange: (page: number) => void; navRef?: React.Ref<HTMLElement> }) {
  return <Pagination ref={navRef}><PaginationContent>
    <PaginationItem><PaginationLink aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeftIcon /></PaginationLink></PaginationItem>
    {paginationItems(page, pages).map((item, i) => <PaginationItem key={`${item}:${i}`}>{item === "ellipsis" ? <PaginationEllipsis /> : <PaginationLink isActive={page === item} aria-label={`第 ${item} 页`} onClick={() => onChange(item)}>{item}</PaginationLink>}</PaginationItem>)}
    <PaginationItem><PaginationLink aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRightIcon /></PaginationLink></PaginationItem>
  </PaginationContent></Pagination>;
}
