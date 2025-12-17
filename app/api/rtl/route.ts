import { inngest } from "@/inngest/client";
import { createSupabaseServer } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const spec = body?.spec?.trim?.() ?? "";
  const title = (body?.title?.trim?.() || "Untitled RTL job").slice(0, 120);

  if (!spec) {
    return NextResponse.json({ error: "spec is required" }, { status: 400 });
  }

  const { data: job, error } = await supabase
    .from("rtl_jobs")
    .insert({
      spec,
      title,
      user_id: user.id,
      status: "queued"
    })
    .select()
    .single();

  if (error || !job) {
    return NextResponse.json(
      { error: "failed to create rtl job", details: error?.message },
      { status: 500 }
    );
  }

  await inngest.send({
    name: "genrtl/rtl.requested",
    data: { jobId: job.id, userId: user.id }
  });

  return NextResponse.json({
    id: job.id,
    status: job.status,
    title: job.title,
    created_at: job.created_at
  });
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { data: job, error } = await supabase
    .from("rtl_jobs")
    .select("id, title, status, plan, code_patch, error, created_at, updated_at, user_id")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  if (job.user_id && job.user_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { user_id: _userId, ...rest } = job;
  return NextResponse.json(rest);
}
