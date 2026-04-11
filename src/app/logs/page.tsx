"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Activity } from "lucide-react";
import { formatDate, getStatusColor, getStatusDot } from "@/lib/utils";

interface LogEvent {
  id: string;
  type: string;
  createdAt: string;
  to?: string;
  subject?: string;
}

export default function LogsPage() {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const fetchLogs = () => {
    setLoading(true);
    fetch("/api/metrics")
      .then((res) => res.json())
      .then((data) => setEvents(data.recentEvents || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const eventTypes = ["all", "email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced", "email.complained"];

  const filteredEvents = typeFilter
    ? events.filter((e) => e.type === typeFilter)
    : events;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Logs</h1>
          <p className="text-sm text-neutral-400 mt-1">Webhook events and email activity timeline</p>
        </div>
        <button
          onClick={fetchLogs}
          className="rounded-lg border border-neutral-700 p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Type Filter */}
      <div className="flex gap-1 mb-6 border-b border-neutral-800 pb-3 overflow-x-auto">
        {eventTypes.map((t) => {
          const label = t === "all" ? "All" : t.replace("email.", "");
          return (
            <button
              key={t}
              onClick={() => setTypeFilter(t === "all" ? null : t)}
              className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors whitespace-nowrap ${
                (t === "all" && !typeFilter) || t === typeFilter
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50"
              }`}
            >
              {label.charAt(0).toUpperCase() + label.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Event Timeline */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50">
        {loading ? (
          <div className="p-5 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center">
            <Activity className="h-8 w-8 mx-auto mb-3 text-neutral-600" />
            <p className="text-sm text-neutral-500">
              No events yet. Events will appear here as emails are sent and delivered.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-800/50">
            {filteredEvents.map((event) => {
              const status = event.type.replace("email.", "");
              return (
                <div key={event.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-neutral-800/20 transition-colors">
                  {/* Timeline dot */}
                  <div className="flex flex-col items-center">
                    <span className={`h-2 w-2 rounded-full ${getStatusDot(status)}`} />
                  </div>

                  {/* Event info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] font-medium capitalize ${getStatusColor(status)}`}>
                        {status}
                      </span>
                      {event.to && (
                        <span className="text-[12px] text-neutral-500">
                          to <span className="text-neutral-400">{event.to}</span>
                        </span>
                      )}
                    </div>
                    {event.subject && (
                      <p className="text-[12px] text-neutral-500 truncate mt-0.5">
                        {event.subject}
                      </p>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-[11px] text-neutral-500 flex-shrink-0">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
