import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { getAssignmentConfig } from "@/lib/assignment";

export async function GET() {
  const config = await getAssignmentConfig();
  return NextResponse.json(config);
}

export async function PUT(req: NextRequest) {
  const body = await req.json();

  if (!body.strong_criteria || !body.assignment) {
    return NextResponse.json(
      { error: "Must include strong_criteria and assignment" },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("system_config")
    .upsert(
      {
        key: "lead_assignment",
        value: body,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, config: body });
}
