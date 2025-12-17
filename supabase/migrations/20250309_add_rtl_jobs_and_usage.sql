-- Add genRTL job tracking and model usage ledger tables
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.rtl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  plan JSONB,
  code_patch TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'plan_in_progress', 'code_in_progress', 'succeeded', 'failed')
  ),
  error TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.model_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES public.rtl_jobs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stage VARCHAR(16) NOT NULL CHECK (stage IN ('plan', 'code')),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rtl_jobs_user_id ON public.rtl_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_rtl_jobs_status ON public.rtl_jobs(status);
CREATE INDEX IF NOT EXISTS idx_rtl_jobs_created_at ON public.rtl_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_logs_job_id ON public.model_usage_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_logs_user_id ON public.model_usage_logs(user_id);

ALTER TABLE public.rtl_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rtl jobs" ON public.rtl_jobs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create rtl jobs" ON public.rtl_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can manage rtl jobs" ON public.rtl_jobs
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view own usage logs" ON public.model_usage_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage usage logs" ON public.model_usage_logs
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
