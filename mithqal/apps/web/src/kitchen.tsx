import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface Ticket { invoice_id: string; number: string; status: "NEW" | "READY"; seconds: number; items: { name: string; quantity: number }[] }

const mmss = (s: number) =>
  `${Math.floor(s / 60).toLocaleString("ar-SA")}:${(s % 60).toLocaleString("ar-SA", { minimumIntegerDigits: 2 })}`;

/** Kitchen / barista display: auto-refreshing ticket wall, oldest first; red after 5 minutes. */
export function Kitchen({ toast }: { toast: (s: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = useCallback(() => {
    api<Ticket[]>("GET", "/v1/kds/tickets").then(setTickets).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  async function setStatus(id: string, status: "READY" | "SERVED") {
    try {
      await api("POST", `/v1/kds/tickets/${id}/status`, { status });
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <div className="page">
      <h2 style={{ marginTop: 0 }}>شاشة التحضير ({tickets.length.toLocaleString("ar-SA")})</h2>
      {tickets.length === 0 && <div className="muted">لا توجد طلبات قيد التحضير ☕</div>}
      <div className="kds">
        {tickets.map((t) => (
          <div key={t.invoice_id} className={`ticket ${t.status === "READY" ? "ready" : t.seconds > 300 ? "late" : ""}`}>
            <div className="row"><strong>{t.number.split("-").pop()}</strong><span>{mmss(t.seconds)}</span></div>
            <ul>{t.items.map((i, k) => <li key={k}><strong>{i.quantity.toLocaleString("ar-SA")}×</strong> {i.name}</li>)}</ul>
            {t.status === "NEW"
              ? <button className="btn primary" onClick={() => setStatus(t.invoice_id, "READY")}>جاهز</button>
              : <button className="btn gold" onClick={() => setStatus(t.invoice_id, "SERVED")}>تم التسليم</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
