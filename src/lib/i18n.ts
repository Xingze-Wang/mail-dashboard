"use client";

import { useState, useEffect } from "react";

export type Locale = "en" | "zh";

const dict: Record<string, Record<Locale, string>> = {
  // ── Sidebar nav ──────────────────────────────────────────────────────
  "nav.overview":        { en: "Overview",        zh: "概览" },
  "nav.missions":        { en: "Today",           zh: "今日" },
  "nav.pipeline":        { en: "Pipeline",        zh: "线索库" },
  "nav.emails":          { en: "Emails",          zh: "邮件" },
  "nav.brief":           { en: "Brief",           zh: "速览" },
  "nav.insights":        { en: "Insights",        zh: "数据洞察" },
  "nav.templates":       { en: "Templates",       zh: "模板" },
  "nav.adminMissions":   { en: "Missions Admin",  zh: "任务管理" },
  "nav.adminAllocation": { en: "Allocation",      zh: "分配" },
  "nav.congress":        { en: "Congress",        zh: "议事厅" },
  "nav.scorer":          { en: "Scorer",          zh: "评分器" },
  "nav.bench":           { en: "Bench",           zh: "基准测试" },
  "nav.drift":           { en: "Drift",           zh: "漂移" },

  // ── Sidebar account menu ─────────────────────────────────────────────
  "account.accounts":      { en: "Accounts",           zh: "账号" },
  "account.add":           { en: "Add another account", zh: "添加账号" },
  "account.settings":      { en: "Settings",           zh: "设置" },
  "account.signout":       { en: "Sign out current",   zh: "退出当前账号" },
  "account.active":        { en: "active",             zh: "当前" },
  "account.admin":         { en: "Admin",              zh: "管理员" },
  "account.growth":        { en: "Growth",             zh: "成长" },
  "account.switching":     { en: "switching…",         zh: "切换中…" },

  // ── Overview page ────────────────────────────────────────────────────
  "overview.title":          { en: "Overview",                zh: "概览" },
  "overview.subtitle":       { en: "Email delivery & activity", zh: "邮件发送与活动" },
  "overview.myPipeline":     { en: "My Pipeline",            zh: "我的线索" },
  "overview.personalView":   { en: "personal view",          zh: "个人视图" },
  "overview.openNextBatch":  { en: "Open next batch",        zh: "打开下一批" },
  "overview.last30":         { en: "Last 30 Days",           zh: "近 30 天" },
  "overview.last30My":       { en: "Last 30 Days — My sends", zh: "近 30 天 — 我的发送" },
  "overview.recentActivity": { en: "Recent Activity",        zh: "最近动态" },
  "overview.noActivity":     { en: "No activity yet",        zh: "暂无动态" },
  "overview.noActivitySub":  { en: "Send your first email to see delivery events here.", zh: "发送第一封邮件后，送达事件将显示在这里。" },
  "overview.failedMetrics":  { en: "Failed to load metrics", zh: "数据加载失败" },

  // ── Overview stats ───────────────────────────────────────────────────
  "stat.sent":         { en: "Sent",              zh: "已发送" },
  "stat.delivered":    { en: "Delivered",         zh: "已送达" },
  "stat.clicked":      { en: "Clicked",           zh: "已点击" },
  "stat.bounced":      { en: "Bounced",           zh: "已退回" },
  "stat.received":     { en: "Received",          zh: "已接收" },
  "stat.wechat":       { en: "WeChat",            zh: "微信" },
  "stat.deliveryRate": { en: "Delivery Rate",     zh: "送达率" },
  "stat.clickRate":    { en: "Click Rate",        zh: "点击率" },
  "stat.leadRate":     { en: "Lead Rate (WeChat)", zh: "转化率（微信）" },
  "stat.replies":      { en: "Replies",           zh: "回复" },
  "stat.assignedToMe": { en: "Assigned to me",   zh: "分配给我" },
  "stat.readyToSend":  { en: "Ready to send",    zh: "待发送" },
  "stat.wechatAdded":  { en: "WeChat added",     zh: "已加微信" },
  "stat.leadRateFull": { en: "Lead rate (WeChat / Sent)", zh: "转化率（微信 / 已发）" },

  // ── Pipeline page ────────────────────────────────────────────────────
  "pipeline.title":    { en: "Pipeline",          zh: "线索库" },
  "pipeline.browse":   { en: "Browse",            zh: "浏览" },
  "pipeline.review":   { en: "Review",            zh: "审核" },
  "pipeline.bulk":     { en: "Bulk",              zh: "批量" },
  "pipeline.export":   { en: "Export",            zh: "导出" },
  "pipeline.scanArxiv":{ en: "Scan arXiv",        zh: "扫描 arXiv" },
  "pipeline.addLead":  { en: "Add lead",          zh: "新增线索" },
  "pipeline.reassign": { en: "Re-assign…",        zh: "重新分配…" },
  "pipeline.settings": { en: "Settings",          zh: "设置" },
  "pipeline.all":      { en: "All",               zh: "全部" },
  "pipeline.allStatus":{ en: "All status",        zh: "全部状态" },
  "pipeline.drafting": { en: "Drafting",          zh: "草稿中" },
  "pipeline.ripening": { en: "Ripening",          zh: "孵化中" },
  "pipeline.ready":    { en: "Ready",             zh: "待发" },
  "pipeline.skipped":  { en: "Skipped",           zh: "已跳过" },
  "pipeline.replied":  { en: "Replied",           zh: "已回复" },
  "pipeline.sortNewest":  { en: "Sort: Newest",       zh: "排序：最新" },
  "pipeline.sortScore":   { en: "Sort: Score",         zh: "排序：评分" },
  "pipeline.sortTier":    { en: "Sort: Tier",          zh: "排序：层级" },
  "pipeline.sortActivity":{ en: "Sort: Last activity", zh: "排序：最近活动" },
  "pipeline.sendingTo":   { en: "Sending to",         zh: "发送给" },
  "pipeline.sending":     { en: "Sending…",           zh: "发送中…" },
  "pipeline.sentAll":     { en: "Sent all",           zh: "全部发送完毕" },

  // ── Emails page ──────────────────────────────────────────────────────
  "emails.title":      { en: "Emails",      zh: "邮件" },
  "emails.sending":    { en: "Sending",     zh: "发件" },
  "emails.receiving":  { en: "Receiving",   zh: "收件" },
  "emails.evtSent":       { en: "Sent",       zh: "已发送" },
  "emails.evtDelivered":  { en: "Delivered",  zh: "已送达" },
  "emails.evtOpened":     { en: "Opened",     zh: "已打开" },
  "emails.evtClicked":    { en: "Clicked",    zh: "已点击" },
  "emails.evtBounced":    { en: "Bounced",    zh: "已退回" },
  "emails.evtComplained": { en: "Complained", zh: "投诉" },
  "emails.hideClicks":    { en: "Hide",       zh: "收起" },
  "emails.showClicks":    { en: "Show",       zh: "展开" },
  "emails.clickDest":     { en: "click destination", zh: "点击目标" },
  "emails.clickDests":    { en: "click destinations", zh: "点击目标" },

  // ── Insights (analysis) page ─────────────────────────────────────────
  "insights.title":       { en: "Insights",            zh: "数据洞察" },
  "insights.loading":     { en: "Picking what matters most…", zh: "正在分析关键数据…" },
  "insights.error":       { en: "Couldn't load insights", zh: "数据加载失败" },
  "insights.empty":       { en: "Nothing worth flagging right now.", zh: "暂无需要关注的内容。" },
  "insights.geo":         { en: "Domestic (.cn) vs Overseas", zh: "国内（.cn）vs 海外" },
  "insights.geoSub":      { en: "Two-stage funnel — clicks come from the opener / subject; conversions come from the body / pitch.", zh: "两段式漏斗 — 点击来自开头/主题，转化来自正文/推销。" },
  "insights.ctr":         { en: "Click rate (clicked / delivered)", zh: "点击率（点击 / 送达）" },
  "insights.conv":        { en: "Post-click conversion (wechat / clicked)", zh: "点击后转化（微信 / 点击）" },
  "insights.domestic":    { en: "Domestic .cn",  zh: "国内 .cn" },
  "insights.overseas":    { en: "Overseas",       zh: "海外" },
  "insights.moreCuts":    { en: "More cuts",      zh: "更多维度" },
  "insights.fullBreak":   { en: "full breakdown", zh: "完整拆解" },
  "insights.vsLastWeek":  { en: "vs last week",   zh: "较上周" },
  "insights.geoLink":     { en: "Geography",      zh: "地区" },
  "insights.geoDesc":     { en: "Domestic .cn vs overseas", zh: "国内 .cn vs 海外" },
  "insights.dirLink":     { en: "Research direction", zh: "研究方向" },
  "insights.dirDesc":     { en: "Per-direction click + post-click conversion", zh: "各方向点击率及点击后转化" },
  "insights.schoolLink":  { en: "School tier",    zh: "学校层级" },
  "insights.schoolDesc":  { en: "Tier 1 / 2 / 3 break-out", zh: "一 / 二 / 三级拆分" },
  "insights.leadLink":    { en: "Lead tier",      zh: "线索层级" },
  "insights.leadDesc":    { en: "Strong vs normal", zh: "强 vs 普通" },
  "insights.hLink":       { en: "H-index",        zh: "H 指数" },
  "insights.hDesc":       { en: "Author seniority buckets", zh: "作者资历分组" },
  "insights.citLink":     { en: "Citation count", zh: "引用量" },
  "insights.citDesc":     { en: "Author impact buckets", zh: "作者影响力分组" },
  "insights.helperHint":  { en: "Tell the helper to change what shows up here — e.g. \"hide drift alerts\", \"focus on click rate\".", zh: "告诉助手修改这里显示的内容 — 例如「隐藏漂移提醒」、「关注点击率」。" },
  "insights.prefs":       { en: "Active preferences:", zh: "当前偏好：" },
  "insights.updated":     { en: "Updated",        zh: "更新于" },

  // ── Drift page ───────────────────────────────────────────────────────
  "drift.title":       { en: "Drift",         zh: "漂移" },
  "drift.patterns":    { en: "Patterns",      zh: "模式" },
  "drift.disagree":    { en: "Disagreements", zh: "分歧" },
  "drift.human":       { en: "Human signals", zh: "人工信号" },
  "drift.pending":     { en: "Pending",       zh: "待处理" },
  "drift.accepted":    { en: "Accepted",      zh: "已采纳" },
  "drift.ignored":     { en: "Ignored",       zh: "已忽略" },
  "drift.all":         { en: "All",           zh: "全部" },
  "drift.mine":        { en: "Run miner",     zh: "运行挖掘" },
  "drift.accept":      { en: "Accept",        zh: "采纳" },
  "drift.ignore":      { en: "Ignore",        zh: "忽略" },

  // ── Scorer page ──────────────────────────────────────────────────────
  "scorer.title":      { en: "Scorer",            zh: "评分器" },
  "scorer.lead":       { en: "Lead quality",      zh: "线索质量" },
  "scorer.email":      { en: "Email quality",     zh: "邮件质量" },
  "scorer.conversion": { en: "Conversion model",  zh: "转化模型" },
  "scorer.match":      { en: "Sales match",       zh: "销售匹配" },

  // ── Bench page ───────────────────────────────────────────────────────
  "bench.title":       { en: "Bench",       zh: "基准测试" },

  // ── Congress page ────────────────────────────────────────────────────
  "congress.title":    { en: "Congress",    zh: "议事厅" },

  // ── Brief page ───────────────────────────────────────────────────────
  "brief.title":       { en: "Brief",       zh: "速览" },

  // ── Templates page ───────────────────────────────────────────────────
  "templates.title":   { en: "Templates",   zh: "模板" },
  "templates.editor":  { en: "Editor",      zh: "编辑" },
  "templates.perf":    { en: "Performance", zh: "效果" },

  // ── Settings ─────────────────────────────────────────────────────────
  "settings.title":    { en: "Settings",    zh: "设置" },

  // ── Common ───────────────────────────────────────────────────────────
  "common.loading":    { en: "Loading…",    zh: "加载中…" },
  "common.error":      { en: "Error",       zh: "错误" },
  "common.save":       { en: "Save",        zh: "保存" },
  "common.cancel":     { en: "Cancel",      zh: "取消" },
  "common.delete":     { en: "Delete",      zh: "删除" },
  "common.edit":       { en: "Edit",        zh: "编辑" },
  "common.create":     { en: "Create",      zh: "创建" },
  "common.update":     { en: "Update",      zh: "更新" },
  "common.search":     { en: "Search…",     zh: "搜索…" },
};

export function t(key: string, locale: Locale): string {
  return dict[key]?.[locale] ?? dict[key]?.en ?? key;
}

export function useLocale(): Locale {
  const [locale, setLocale] = useState<Locale>("en");
  useEffect(() => {
    const lang = navigator.language ?? "";
    setLocale(lang.startsWith("zh") ? "zh" : "en");
  }, []);
  return locale;
}
