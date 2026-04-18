"use client";

import { SelectHTMLAttributes } from "react";

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  uiSize?: "sm" | "md";
};

export function Select({ className = "", uiSize = "md", ...rest }: Props) {
  const cls = uiSize === "sm" ? "rep-select" : "filter-select";
  return <select {...rest} className={`${cls} ${className}`} />;
}
