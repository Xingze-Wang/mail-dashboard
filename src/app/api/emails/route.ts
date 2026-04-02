import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");

  const where = status ? { status } : {};

  const [emails, total] = await Promise.all([
    prisma.email.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        events: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    }),
    prisma.email.count({ where }),
  ]);

  return NextResponse.json({ emails, total, page, limit });
}
