import { useState, useMemo, useRef, useCallback, useEffect, Component } from "react";

// --- Error Boundary ---
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <div style={{ padding: 16, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#991b1b" }}>
        計算中にエラーが発生しました。入力値を確認してください。
        <button onClick={() => this.setState({ hasError: false })} style={{ marginLeft: 8, fontSize: 11, cursor: "pointer" }}>再試行</button>
      </div>;
    }
    return this.props.children;
  }
}

// --- Mobile detection hook ---
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= breakpoint);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);
  return isMobile;
}

// --- GA4 helper ---
const gtag = (...args) => { if (typeof window !== "undefined" && window.gtag) window.gtag(...args); };
const trackEvent = (name, params) => gtag("event", name, params);

// --- Tax ---
const BRACKETS = [
  { limit: 1950000, rate: 0.05 }, { limit: 3300000, rate: 0.10 },
  { limit: 6950000, rate: 0.20 }, { limit: 9000000, rate: 0.23 },
  { limit: 18000000, rate: 0.33 }, { limit: 40000000, rate: 0.40 },
  { limit: Infinity, rate: 0.45 },
];
const RESIDENT_TAX = 0.10;
const SRC_WH = 0.2042;

function getMarginal(income) { for (const b of BRACKETS) { if (income <= b.limit) return b.rate; } return 0.45; }
function getPersonalRate(income) { const m = getMarginal(income); return m + m * 0.021 + RESIDENT_TAX; }

// --- Calc ---
function daysBetween(d1, d2) {
  if (!d1 || !d2) return null;
  const a = new Date(d1), b = new Date(d2);
  return (isNaN(a) || isNaN(b)) ? null : Math.max(0, Math.round((b - a) / 86400000));
}

function resolveDays(mode, days, dateStart, dateEnd) {
  if (mode === "date") { const d = daysBetween(dateStart, dateEnd); return d !== null ? d : (parseFloat(days) || 0); }
  return parseFloat(days) || 0;
}

function calcCampaignTotal(campaigns, investAmt) {
  let total = 0;
  campaigns.forEach(c => {
    if (!c.enabled) return;
    total += c.type === "fixed" ? (parseFloat(c.value) || 0) : investAmt * ((parseFloat(c.value) || 0) / 100);
  });
  return total;
}

function calcCampaignForIRR() { /* unused, kept for compat */ return 0; }

// Proper IRR via Newton-Raphson on actual cash flow timeline
function solveIRR(cashflows) {
  // cashflows: [{day, amount}] where day=0 is investment start
  // Returns annualized IRR or null if not solvable
  if (!cashflows.length) return null;
  let r = 0.08; // initial guess 8%
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0, dnpv = 0;
    for (const cf of cashflows) {
      const t = cf.day / 365;
      const disc = Math.pow(1 + r, t);
      if (!isFinite(disc) || disc === 0) break;
      npv += cf.amount / disc;
      dnpv -= t * cf.amount / (disc * (1 + r));
    }
    if (Math.abs(npv) < 0.01) return r;
    if (dnpv === 0) break;
    r = r - npv / dnpv;
    if (r < -0.99 || r > 100 || !isFinite(r)) break;
  }
  return isFinite(r) && r > -0.99 ? r : null;
}

function calc(fund, tax) {
  try {
  const y = parseFloat(fund.yield) / 100 || 0;
  const m = parseFloat(fund.months) || 0;
  const amt = (parseFloat(fund.amount) || 0) * 10000;
  if (!isFinite(amt) || amt <= 0 || !isFinite(m) || m <= 0) return null;
  if (!isFinite(y)) return null;

  const waitD = resolveDays(fund.waitMode, fund.waitDays, fund.waitDateStart, fund.waitDateEnd);
  const retD = resolveDays(fund.returnMode, fund.returnDays, fund.returnDateStart, fund.returnDateEnd);
  const opDays = Math.round(m * 30.44);
  const totalDays = waitD + opDays + retD;
  const totalMonths = totalDays / 30.44;

  const profit = amt * y * (m / 12);
  const campAmt = calcCampaignTotal(fund.campaigns || [], amt);
  const realYield = y * (opDays / (waitD + opDays));
  const campYield = totalMonths > 0 ? ((profit + campAmt) / amt) * (12 / totalMonths) : 0;

  // Build cash flow timeline for IRR
  const cashflows = [{ day: 0, amount: -amt }]; // investment outflow at day 0
  // Campaign inflows at their respective timings
  (fund.campaigns || []).forEach(c => {
    if (!c.enabled) return;
    const cAmt = c.type === "fixed" ? (parseFloat(c.value) || 0) : amt * ((parseFloat(c.value) || 0) / 100);
    if (cAmt <= 0) return;
    const delay = parseFloat(c.delayDays) || 0;
    cashflows.push({ day: waitD + delay, amount: cAmt });
  });
  // Dividend schedule: mid-term distributions
  const activeDivs = (fund.dividends || []).filter(d => d.enabled && parseFloat(d.months) > 0);
  let distribTotal = 0;
  activeDivs.forEach(d => {
    const dAmt = d.type === "fixed" ? (parseFloat(d.value) || 0) : amt * ((parseFloat(d.value) || 0) / 100);
    if (dAmt <= 0) return;
    distribTotal += dAmt;
    const dDay = waitD + Math.round((parseFloat(d.months) || 0) * 30.44);
    cashflows.push({ day: dDay, amount: dAmt });
  });
  // Principal + remaining profit at end
  const remainingProfit = Math.max(0, profit - distribTotal);
  cashflows.push({ day: totalDays, amount: amt + remainingProfit });
  const irr = solveIRR(cashflows);

  const r = { waitD, retD, opDays, totalDays, totalMonths, profit, campAmt, realYield, campYield, irr };

  const calcTax = (rate) => {
    const taxAmt = profit * rate;
    const withheld = profit * SRC_WH;
    return { rate, taxAmt, withheld, diff: taxAmt - withheld, net: profit - taxAmt + campAmt };
  };

  if (tax.entity === "personal" || tax.entity === "both") {
    const rate = tax.personalMode === "direct" ? (parseFloat(tax.personalDirect) || 0) / 100 : getPersonalRate(parseFloat(tax.personalIncome) || 0);
    r.personal = calcTax(rate);
  }
  if (tax.entity === "corporate" || tax.entity === "both") {
    r.corporate = calcTax((parseFloat(tax.corpRate) || 0) / 100);
  }
  return r;
  } catch (e) { console.error("calc error:", e); return null; }
}

// --- Styles ---
const S = {
  page: { minHeight: "100vh", fontFamily: "'Noto Sans JP',-apple-system,BlinkMacSystemFont,'Hiragino Sans','Hiragino Kaku Gothic ProN',Meiryo,sans-serif", background: "#f3f5f8", color: "#1a2332" },
  hdr: { background: "linear-gradient(135deg,#0c1e33,#1a3a5c)", padding: "20px 20px 16px", color: "#fff" },
  wrap: { maxWidth: 1000, margin: "0 auto", padding: "0 12px" },
  sec: { background: "#fff", borderRadius: 10, border: "1px solid #e2e8f0", padding: 16, marginBottom: 14 },
  lbl: { display: "block", fontSize: 10.5, color: "#5a6a7e", marginBottom: 3, fontWeight: 500 },
  inp: { width: "100%", padding: "7px 9px", border: "1px solid #d0d7de", borderRadius: 5, fontSize: 13, fontFamily: "'DM Mono','SF Mono',Consolas,Monaco,monospace", background: "#f8fafc", outline: "none", boxSizing: "border-box" },
  dinp: { width: "100%", padding: "6px 8px", border: "1px solid #d0d7de", borderRadius: 5, fontSize: 12, background: "#f8fafc", outline: "none", boxSizing: "border-box" },
  sel: { padding: "6px 8px", border: "1px solid #d0d7de", borderRadius: 5, fontSize: 11, background: "#f8fafc", outline: "none" },
  btn: { background: "#1a3a5c", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  gbtn: { background: "transparent", color: "#1a3a5c", border: "1px solid #1a3a5c", borderRadius: 6, padding: "5px 11px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  tag: (bg, c) => ({ display: "inline-block", background: bg, color: c, padding: "1px 7px", borderRadius: 3, fontSize: 9.5, fontWeight: 700, marginRight: 4 }),
  mono: { fontFamily: "'DM Mono','SF Mono',Consolas,Monaco,monospace" },
  g2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  g3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
  g4: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 },
};

function Tip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", marginLeft: 4, verticalAlign: "middle" }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onClick={() => setShow(!show)}>
      <span style={{
        width: 14, height: 14, borderRadius: "50%", background: "#d0d7de", color: "#475569",
        fontSize: 9, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: "help", userSelect: "none", lineHeight: 1
      }}>i</span>
      {show && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "#1a2332", color: "#fff", fontSize: 10.5, lineHeight: 1.5, padding: "8px 12px",
          borderRadius: 6, width: 240, zIndex: 100, boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          pointerEvents: "none", whiteSpace: "normal", fontWeight: 400
        }}>{text}
          <span style={{
            position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
            border: "5px solid transparent", borderTopColor: "#1a2332"
          }} />
        </span>
      )}
    </span>
  );
}

function F({ label, children, style, tip }) {
  return (
    <label style={{ display: "block", marginBottom: 8, ...style }}>
      <span style={S.lbl}>{label}{tip && <Tip text={tip} />}</span>
      {children}
    </label>
  );
}
function I({ label, value, onChange, suffix, style, tip }) {
  return (
    <F label={label} style={style} tip={tip}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input type="number" value={value} onChange={e => onChange(e.target.value)} step="any" style={S.inp} />
        {suffix && <span style={{ fontSize: 12, color: "#4a5568", fontWeight: 600, whiteSpace: "nowrap" }}>{suffix}</span>}
      </div>
    </F>
  );
}

function Toggle({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d0d7de", borderRadius: 4, overflow: "hidden" }}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} style={{
          padding: "2px 10px", fontSize: 10, border: "none", cursor: "pointer",
          background: value === k ? "#1a3a5c" : "#fff", color: value === k ? "#fff" : "#64748b", fontWeight: 600
        }}>{l}</button>
      ))}
    </div>
  );
}

// --- Tax Settings ---
function TaxPanel({ tax, onChange, isMobile }) {
  const up = (k, v) => onChange({ ...tax, [k]: v });
  const tabs = [["personal", "個人"], ["corporate", "法人"], ["both", "個人・法人比較"]];

  const showPersonal = tax.entity === "personal" || tax.entity === "both";
  const showCorp = tax.entity === "corporate" || tax.entity === "both";

  let personalRate = 0;
  if (tax.personalMode === "direct") {
    personalRate = (parseFloat(tax.personalDirect) || 0) / 100;
  } else {
    personalRate = getPersonalRate(parseFloat(tax.personalIncome) || 0);
  }

  return (
    <div style={S.sec}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>⚙️ 税金設定</h2>
        <Toggle options={tabs} value={tax.entity} onChange={v => up("entity", v)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
        {showPersonal && (
          <div style={{ padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e8ecf0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#374151" }}>👤 個人投資家</span>
              <Toggle options={[["income", "課税所得から"], ["direct", "税率直接入力"]]} value={tax.personalMode} onChange={v => up("personalMode", v)} />
            </div>
            {tax.personalMode === "income" ? (
              <>
                <I label="課税所得（年間）" value={tax.personalIncome} onChange={v => up("personalIncome", v)} suffix="円" tip="源泉徴収票の「給与所得控除後の金額」から「所得控除の額の合計額」を引いた金額。不明な場合は年収の60〜70%程度を目安に入力してください。" />
                <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>
                  所得税 {(getMarginal(parseFloat(tax.personalIncome) || 0) * 100).toFixed(0)}% + 住民税 10% + 復興税 → 実効税率 <strong style={S.mono}>{(personalRate * 100).toFixed(1)}%</strong>
                  {personalRate < SRC_WH && <span style={{ color: "#059669", fontWeight: 600 }}> → 還付あり</span>}
                  {personalRate > SRC_WH && <span style={{ color: "#dc2626", fontWeight: 600 }}> → 追加納税あり</span>}
                </div>
              </>
            ) : (
              <>
                <I label="実効税率（所得税+住民税+復興税の合計）" value={tax.personalDirect} onChange={v => up("personalDirect", v)} suffix="%" tip="所得税の限界税率＋住民税10%＋復興特別所得税を合算した税率。課税所得695万円以下なら約30%、900万円超なら約33%が目安です。" />
                <div style={{ fontSize: 10, color: "#64748b" }}>
                  源泉徴収 20.42% との差分で還付/追加納税を計算します
                </div>
              </>
            )}
          </div>
        )}
        {showCorp && (
          <div style={{ padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e8ecf0" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 8 }}>🏢 法人</span>
            <I label="法人実効税率" value={tax.corpRate} onChange={v => up("corpRate", v)} suffix="%" tip="法人税・法人住民税・事業税を合算した実効税率。中小法人（所得800万円以下）は約25%、大法人・800万円超は約34%が一般的な目安です。" />
            <div style={{ fontSize: 10, color: "#64748b" }}>中小法人（所得800万以下）≈25%、それ以上≈34%が目安</div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Campaign Item ---
const EMPTY_CAMP = { enabled: false, type: "fixed", value: "0", delayDays: "" };
const EMPTY_DIV = { enabled: false, months: "", type: "rate", value: "" };

function CampaignItem({ camp, index, onChange }) {
  const up = (k, v) => onChange({ ...camp, [k]: v });
  if (!camp.enabled) {
    return (
      <button onClick={() => up("enabled", true)} style={{ ...S.gbtn, fontSize: 10, color: "#64748b", borderColor: "#d0d7de", width: "100%" }}>
        ＋ キャンペーン{index + 1}を追加
      </button>
    );
  }
  return (
    <div style={{ padding: 10, background: "#fff", borderRadius: 6, border: "1px solid #e2e8f0", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "#475569" }}>キャンペーン{index + 1}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <select value={camp.type} onChange={e => up("type", e.target.value)} style={S.sel}>
            <option value="fixed">定額（円）</option>
            <option value="rate">定率（投資額の%）</option>
          </select>
          <button onClick={() => onChange({ ...EMPTY_CAMP })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#64748b", padding: 0 }}>✕</button>
        </div>
      </div>
      <div style={S.g2}>
        <I label={camp.type === "fixed" ? "還元額" : "還元率"} value={camp.value} onChange={v => up("value", v)} suffix={camp.type === "fixed" ? "円" : "%"} tip={camp.type === "fixed" ? "Amazonギフト券、ワイズコイン等のキャンペーン還元額を円単位で入力。各事業者のキャンペーンページで確認できます。" : "投資額に対する還元率（%）。例：投資額の0.5%還元の場合は「0.5」と入力。"} />
        <I label="付与タイミング（投資開始から）" value={camp.delayDays} onChange={v => up("delayDays", v)} suffix="日後" tip="キャンペーン還元がいつ付与されるか。例：「入金月の翌月末」なら約60日。不明な場合は空欄でOK（即時付与として計算）。" />
      </div>
    </div>
  );
}

function DividendItem({ div, index, onChange, investAmt }) {
  const up = (k, v) => onChange({ ...div, [k]: v });
  if (!div.enabled) {
    return (
      <button onClick={() => up("enabled", true)} style={{ ...S.gbtn, fontSize: 10, color: "#64748b", borderColor: "#d0d7de", width: "100%" }}>
        ＋ 配当{index + 1}を追加
      </button>
    );
  }
  const amt = div.type === "rate" ? (investAmt * (parseFloat(div.value) || 0) / 100) : (parseFloat(div.value) || 0);
  return (
    <div style={{ padding: 8, background: "#fff", borderRadius: 6, border: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: "#475569", whiteSpace: "nowrap", minWidth: 42 }}>配当{index + 1}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "0 0 100px" }}>
        <input type="number" value={div.months} onChange={e => up("months", e.target.value)} step="1" style={{ ...S.inp, width: 50, padding: "5px 6px", fontSize: 12 }} />
        <span style={{ fontSize: 10, color: "#4a5568", whiteSpace: "nowrap" }}>ヶ月後</span>
      </div>
      <select value={div.type} onChange={e => up("type", e.target.value)} style={{ ...S.sel, fontSize: 10 }}>
        <option value="rate">投資額の%</option>
        <option value="fixed">定額（円）</option>
      </select>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
        <input type="number" value={div.value} onChange={e => up("value", e.target.value)} step="any" style={{ ...S.inp, padding: "5px 6px", fontSize: 12 }} />
        <span style={{ fontSize: 10, color: "#4a5568", whiteSpace: "nowrap" }}>{div.type === "rate" ? "%" : "円"}</span>
      </div>
      {amt > 0 && <span style={{ fontSize: 9, color: "#64748b", whiteSpace: "nowrap" }}>≈¥{Math.round(amt).toLocaleString()}</span>}
      <button onClick={() => onChange({ ...EMPTY_DIV })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#64748b", padding: 0 }}>✕</button>
    </div>
  );
}

// --- Fund Input ---
function FundInput({ fund, index, onUpdate, onRemove, onCopy, canRemove, isFirst, isMobile }) {
  const up = (k, v) => onUpdate(index, { ...fund, [k]: v });
  const upCamp = (i, c) => { const cs = [...fund.campaigns]; cs[i] = c; up("campaigns", cs); };
  const upDiv = (i, d) => { const ds = [...fund.dividends]; ds[i] = d; up("dividends", ds); };
  const investAmt = (parseFloat(fund.amount) || 0) * 10000;
  const dateGrid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8, ...(isMobile ? {} : { maxWidth: 400 }) };

  return (
    <div style={S.sec}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "#1a3a5c", color: "#fff", width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>{index + 1}</span>
          <input value={fund.name} onChange={e => up("name", e.target.value)} placeholder="ファンド名を入力（シェア画像にも反映）" style={{ border: "none", borderBottom: "1px solid transparent", fontSize: 14, fontWeight: 700, background: "transparent", outline: "none", width: isMobile ? 180 : 280, cursor: "text", transition: "border-color 0.15s" }} onMouseEnter={e => e.target.style.borderBottomColor = "#94a3b8"} onMouseLeave={e => { if (document.activeElement !== e.target) e.target.style.borderBottomColor = "transparent"; }} onFocus={e => e.target.style.borderBottomColor = "#1a3a5c"} onBlur={e => e.target.style.borderBottomColor = "transparent"} />
          <span style={{ fontSize: 12, color: "#c0c8d4", marginLeft: -4 }}>✏️</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {!isFirst && <button onClick={() => onCopy(index)} style={S.gbtn}>📋 前をコピー</button>}
          {canRemove && <button onClick={() => onRemove(index)} style={{ ...S.gbtn, color: "#64748b", borderColor: "#d0d7de" }}>✕</button>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 8 }}>
        <I label="想定利回り（年利）" value={fund.yield} onChange={v => up("yield", v)} suffix="%" tip="各事業者のファンド詳細ページに記載されている「想定利回り」「予定分配率」等の数値（年利表示）を入力してください。" />
        <I label="運用期間" value={fund.months} onChange={v => up("months", v)} suffix="ヶ月" tip="ファンド詳細ページに記載の「運用期間」を月数で入力。例：6ヶ月、12ヶ月、18ヶ月など。" />
        <I label="投資予定額" value={fund.amount} onChange={v => up("amount", v)} suffix="万円" tip="このファンドに投資する（検討中の）金額を万円単位で入力してください。" />
      </div>

      {/* Wait period */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#475569" }}>待機期間（入金〜運用開始）</span>
          <Toggle options={[["date", "日付"], ["days", "日数"]]} value={fund.waitMode} onChange={v => up("waitMode", v)} />
        </div>
        {fund.waitMode === "date" ? (
          <div style={dateGrid}>
            <F label="入金日 / 資金確保日" tip="ファンドへの入金締切日、または手元に投資資金が空いた日を入力。後者を入れると、資金の遊休期間も含めた投資効率を比較できます。"><input type="date" value={fund.waitDateStart} onChange={e => up("waitDateStart", e.target.value)} style={S.dinp} /></F>
            <F label="運用開始日" tip="ファンド詳細ページに記載の「運用開始予定日」。入金締切日の数日〜数週間後に設定されていることが多いです。"><input type="date" value={fund.waitDateEnd} onChange={e => up("waitDateEnd", e.target.value)} style={S.dinp} /></F>
          </div>
        ) : (
          <div style={{ maxWidth: 200 }}><I label="" value={fund.waitDays} onChange={v => up("waitDays", v)} suffix="日" tip="入金してから運用が始まるまでのおおよその日数。正確な日付がわからない場合の概算用です。" /></div>
        )}
      </div>

      {/* Return period */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#475569" }}>償還待ち（運用終了〜返金）</span>
          <Toggle options={[["date", "日付"], ["days", "日数"]]} value={fund.returnMode} onChange={v => up("returnMode", v)} />
        </div>
        {fund.returnMode === "date" ? (
          <div style={dateGrid}>
            <F label="運用終了日" tip="ファンド詳細ページに記載の「運用終了予定日」。キャピタル型は早期償還で前倒しになることもあります。"><input type="date" value={fund.returnDateStart} onChange={e => up("returnDateStart", e.target.value)} style={S.dinp} /></F>
            <F label="償還日" tip="元本と分配金が口座に振り込まれる予定日。運用終了から数日〜1ヶ月程度かかるのが一般的です。事業者のFAQやマイページで確認できます。"><input type="date" value={fund.returnDateEnd} onChange={e => up("returnDateEnd", e.target.value)} style={S.dinp} /></F>
          </div>
        ) : (
          <div style={{ maxWidth: 200 }}><I label="" value={fund.returnDays} onChange={v => up("returnDays", v)} suffix="日" tip="運用終了から元本が返金されるまでのおおよその日数。事業者により異なりますが、一般的に14〜30日程度です。" /></div>
        )}
      </div>

      {/* Campaign section - collapsible */}
      <div>
        <button onClick={() => { if (!fund.showCampaign) trackEvent("open_campaign_settings", { fund_name: fund.name }); up("showCampaign", !fund.showCampaign); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#475569", padding: 0, fontWeight: 600 }}>
          {fund.showCampaign ? "▾" : "▸"} 🎁 キャンペーン・ポイント設定
          {fund.campaigns.some(c => c.enabled) && <span style={{ ...S.tag("#dbeafe", "#1e40af"), marginLeft: 6 }}>設定あり</span>}
        </button>
        {fund.showCampaign && (
          <div style={{ marginTop: 8, padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px dashed #d0d7de", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}>
              Amazonギフト券、ワイズコイン等のキャンペーン還元を登録できます。複数のキャンペーンが併用されている場合は追加してください。
            </div>
            {fund.campaigns.map((c, i) => <CampaignItem key={i} camp={c} index={i} onChange={c => upCamp(i, c)} />)}
          </div>
        )}
      </div>

      {/* Dividend schedule - collapsible */}
      <div style={{ marginTop: 6 }}>
        <button onClick={() => up("showDividends", !fund.showDividends)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#475569", padding: 0, fontWeight: 600 }}>
          {fund.showDividends ? "▾" : "▸"} 📅 配当スケジュール
          {fund.dividends.some(d => d.enabled) ? <span style={{ ...S.tag("#dbeafe", "#1e40af"), marginLeft: 6 }}>設定あり</span> : <span style={{ fontSize: 10, color: "#64748b", marginLeft: 6 }}>（設定なし＝運用終了時に一括配当として計算）</span>}
        </button>
        {fund.showDividends && (
          <div style={{ marginTop: 8, padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px dashed #d0d7de", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}>
              運用期間中に中間配当があるファンドの場合、配当タイミングを登録するとIRRに反映されます。設定しない場合は、運用終了時に一括配当されるものとして計算します。
              「投資額の%」は配当1回あたりの実受取率（年利換算ではなく実額ベース）を入力してください。
            </div>
            {fund.dividends.map((d, i) => <DividendItem key={i} div={d} index={i} onChange={d => upDiv(i, d)} investAmt={investAmt} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Metric ---
function M({ label, value, sub, accent, tip }) {
  return (
    <div style={{ background: accent ? "linear-gradient(135deg,#0f2a47,#1e4a7a)" : "#f0f4f8", borderRadius: 8, padding: "10px 12px", color: accent ? "#fff" : "#1a2332" }}>
      <div style={{ fontSize: 9.5, opacity: 0.65, fontWeight: 500, marginBottom: 3 }}>{label}{tip && <Tip text={tip} />}</div>
      <div style={{ fontSize: 17, fontWeight: 700, ...S.mono }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, marginTop: 2, opacity: 0.7 }}>{sub}</div>}
    </div>
  );
}

// --- Share Card (hidden, rendered offscreen for html2canvas) ---
const SHARE_BG = "linear-gradient(160deg, #0a1628 0%, #122744 40%, #0f2035 100%)";
const SHARE_FONT = "'Noto Sans JP', sans-serif";
const SHARE_MONO = { fontFamily: "'Noto Sans JP', sans-serif", fontVariantNumeric: "tabular-nums" };

function ShareCardSingle({ fund, r, cardRef }) {
  const f2 = (n, d = 2) => isFinite(n) ? n.toFixed(d) : "—";
  const yen = n => isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "—";
  const name = fund.name || "ファンド";
  const nominalYield = parseFloat(fund.yield) || 0;
  const realYield = (r.realYield || 0) * 100;
  const diff = nominalYield - realYield;
  const campYield = (r.campYield || 0) * 100;
  const irrVal = (r.irr || 0) * 100;
  const hasCamp = r.campAmt > 0;

  // Build sub-cards
  const subCards = [];
  if (hasCamp) subCards.push({ label: "CP込み", value: `${f2(campYield)}%`, diff: nominalYield - campYield });
  subCards.push({ label: "IRR（年率）", value: `${f2(irrVal)}%`, diff: nominalYield - irrVal });
  // Tax card
  const netParts = [];
  if (r.personal) netParts.push(`個人 ${yen(r.personal.net)}`);
  if (r.corporate) netParts.push(`法人 ${yen(r.corporate.net)}`);
  if (netParts.length) subCards.push({ label: "税引後手取り", value: netParts.join(" / "), diff: null });

  const cardWidth = subCards.length === 2 ? 480 : 320;

  return (
    <div ref={cardRef} style={{
      position: "absolute", left: -9999, top: -9999, width: 1200, height: 1200,
      background: SHARE_BG, fontFamily: SHARE_FONT,
      color: "#fff", display: "flex", flexDirection: "column", alignItems: "center",
      padding: "52px 56px", boxSizing: "border-box",
    }}>
      {/* Brand top-left */}
      <div style={{ position: "absolute", top: 40, left: 52, fontSize: 22, fontWeight: 700, color: "#fff", opacity: 0.6, letterSpacing: 0.5 }}>FudoCalc</div>
      {/* URL bottom-right */}
      <div style={{ position: "absolute", bottom: 40, right: 52, fontSize: 18, color: "#fff", opacity: 0.3 }}>fudocalc.com</div>

      {/* Fund name */}
      <div style={{ marginTop: 60, fontSize: 48, fontWeight: 700, letterSpacing: 1, textAlign: "center" }}>{name}</div>

      {/* Pill tags */}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        {[`${fund.amount}万円`, `運用${fund.months}ヶ月`, `待機${r.waitD}日`].map((t, i) => (
          <span key={i} style={{ background: "rgba(255,255,255,0.12)", color: "#fff", borderRadius: 99, padding: "8px 24px", fontSize: 22 }}>{t}</span>
        ))}
      </div>

      {/* Main yield gap area */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 40, marginTop: 80 }}>
        {/* Nominal yield - muted + strikethrough */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>公表利回り</div>
          <div style={{
            fontSize: 78, fontWeight: 700, color: "rgba(255,255,255,0.4)",
            textDecoration: "line-through", textDecorationColor: "rgba(239,68,68,0.6)", textDecorationThickness: 3,
            ...SHARE_MONO,
          }}>{f2(nominalYield, 1)}%</div>
        </div>

        {/* Arrow */}
        <div style={{ fontSize: 48, color: "#fff", marginTop: 24 }}>→</div>

        {/* Real yield - hero */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, color: "rgba(74,222,128,0.7)", letterSpacing: 1, marginBottom: 8 }}>実質利回り</div>
          <div style={{ fontSize: 108, fontWeight: 800, color: "#4ade80", ...SHARE_MONO }}>
            {f2(realYield)}<span style={{ fontSize: 60 }}>%</span>
          </div>
        </div>
      </div>

      {/* Diff text */}
      <div style={{ fontSize: 26, fontWeight: 600, color: "rgba(239,68,68,0.7)", marginTop: 16 }}>
        ▼ {f2(diff, 1)}% の差（待機期間の影響）
      </div>

      {/* Separator */}
      <div style={{ width: 120, height: 1, background: "rgba(255,255,255,0.1)", margin: "40px 0" }} />

      {/* Sub-metric cards */}
      <div style={{ display: "flex", gap: 20, justifyContent: "center" }}>
        {subCards.map((c, i) => (
          <div key={i} style={{
            background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: "14px 8px",
            textAlign: "center", width: cardWidth,
          }}>
            <div style={{ fontSize: 18, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>{c.label}</div>
            <div style={{ fontSize: 36, fontWeight: 600, color: "#fff", ...SHARE_MONO }}>{c.value}</div>
            <div style={{ fontSize: 16, color: c.diff != null ? "rgba(239,68,68,0.5)" : "transparent", marginTop: 4 }}>
              {c.diff != null ? `▼${f2(c.diff, 1)}%` : "_"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareCardComparison({ funds, tax, cardRef }) {
  const f2 = (n, d = 2) => isFinite(n) ? n.toFixed(d) : "—";
  const rows = funds.map((f, i) => ({ name: f.name || `ファンド${i + 1}`, r: calc(f, tax), i })).filter(x => x.r);
  if (rows.length < 2) return null;
  const bestOf = fn => { let b = 0; rows.forEach((x, i) => { if (fn(x.r) > fn(rows[b].r)) b = i; }); return b; };
  const bIRR = bestOf(r => r.irr || 0);
  const bReal = bestOf(r => r.realYield || 0);

  return (
    <div ref={cardRef} style={{
      position: "absolute", left: -9999, top: -9999, width: 1200, height: 1200,
      background: SHARE_BG, fontFamily: SHARE_FONT,
      color: "#fff", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
      padding: "52px 56px", boxSizing: "border-box",
    }}>
      <div style={{ position: "absolute", top: 40, left: 52, fontSize: 22, fontWeight: 700, color: "#fff", opacity: 0.6, letterSpacing: 0.5 }}>FudoCalc</div>
      <div style={{ position: "absolute", bottom: 40, right: 52, fontSize: 18, color: "#fff", opacity: 0.3 }}>fudocalc.com</div>

      <div style={{ fontSize: 36, fontWeight: 700, marginBottom: 48 }}>ファンド比較</div>

      <table style={{ borderCollapse: "collapse", width: "92%", fontSize: 22 }}>
        <thead>
          <tr>
            {["ファンド", "公表利回り", "実質利回り", "CP込み", "IRR（年率）"].map((h, i) => (
              <th key={i} style={{ padding: "16px 18px", textAlign: i ? "center" : "left", borderBottom: "2px solid rgba(255,255,255,0.15)", fontSize: 18, fontWeight: 600, color: "rgba(255,255,255,0.5)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((x, i) => (
            <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <td style={{ padding: "18px 18px", fontWeight: 700, fontSize: 22 }}>{x.name}</td>
              <td style={{ padding: "18px 18px", textAlign: "center", color: "rgba(255,255,255,0.4)", textDecoration: "line-through", textDecorationColor: "rgba(239,68,68,0.4)", ...SHARE_MONO }}>{f2(parseFloat(funds[x.i].yield), 1)}%</td>
              <td style={{ padding: "18px 18px", textAlign: "center", fontWeight: 700, color: i === bReal ? "#4ade80" : "#fff", ...SHARE_MONO }}>
                {i === bReal && <span style={{ background: "#4ade80", color: "#0a1628", padding: "3px 10px", borderRadius: 4, fontSize: 13, fontWeight: 700, marginRight: 8 }}>BEST</span>}
                {f2(x.r.realYield * 100)}%
              </td>
              <td style={{ padding: "18px 18px", textAlign: "center", ...SHARE_MONO }}>{f2(x.r.campYield * 100)}%</td>
              <td style={{ padding: "18px 18px", textAlign: "center", fontWeight: 700, color: i === bIRR ? "#4ade80" : "#fff", ...SHARE_MONO }}>
                {i === bIRR && <span style={{ background: "#4ade80", color: "#0a1628", padding: "3px 10px", borderRadius: 4, fontSize: 13, fontWeight: 700, marginRight: 8 }}>BEST</span>}
                {f2(x.r.irr * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Share Button ---
function ShareButton({ label, onCapture, tweetText }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleShare = useCallback(async () => {
    setOpen(o => !o);
  }, []);

  const handleDownload = useCallback(async () => {
    setLoading(true);
    try {
      const canvas = await onCapture();
      const link = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      link.download = `fudocalc_${label}_${date}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      setLoading(false);
    }
  }, [onCapture, label]);

  const handleTweet = useCallback(() => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent("https://fudocalc.com")}`;
    window.open(url, "_blank");
  }, [tweetText]);

  return (
    <div style={{ display: "inline-block", position: "relative" }}>
      <button onClick={handleShare} style={{ ...S.gbtn, fontSize: 10, padding: "4px 10px", color: "#64748b", borderColor: "#d0d7de" }}>
        📤 シェア
      </button>
      {open && (
        <div style={{
          marginTop: 6, padding: 10, background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0",
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)", display: "flex", gap: 8, alignItems: "center",
          animation: "slideDown 0.15s ease-out",
        }}>
          <style>{`@keyframes slideDown { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          <button onClick={handleDownload} disabled={loading} style={{ ...S.btn, fontSize: 10.5, padding: "6px 12px", background: loading ? "#94a3b8" : "#1a3a5c" }}>
            {loading ? "生成中..." : "💾 画像をダウンロード"}
          </button>
          <button onClick={handleTweet} style={{ ...S.btn, fontSize: 10.5, padding: "6px 12px", background: "#0f1419" }}>
            𝕏 でシェア
          </button>
        </div>
      )}
    </div>
  );
}

// --- Fund Result ---
function FundResult({ fund, index, tax, isMobile }) {
  const r = calc(fund, tax);
  const cardRef = useRef(null);
  const tracked = useRef(false);
  const handleCapture = useCallback(async () => {
    if (!cardRef.current) return null;
    await document.fonts.ready;
    const html2canvas = (await import("html2canvas")).default;
    return html2canvas(cardRef.current, { width: 1200, height: 1200, scale: 1, useCORS: true, backgroundColor: null });
  }, []);

  if (!r) return null;
  if (!tracked.current) { tracked.current = true; trackEvent("calc_result", { fund_name: fund.name || `ファンド${index + 1}`, irr: r.irr ? (r.irr * 100).toFixed(2) : null }); }
  const f2 = (n, d = 2) => isFinite(n) ? n.toFixed(d) : "—";
  const yen = n => isFinite(n) ? (n < 0 ? `▲¥${Math.abs(Math.round(n)).toLocaleString()}` : `¥${Math.round(n).toLocaleString()}`) : "—";
  const g = isMobile ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } : S.g4;

  const name = fund.name || `ファンド${index + 1}`;
  const nominalYield = parseFloat(fund.yield) || 0;
  const realYieldPct = f2(r.realYield * 100);
  const diffPct = f2(nominalYield - r.realYield * 100, 1);
  const irrPct = f2(r.irr * 100);
  const netStr = r.personal ? yen(r.personal.net) : r.corporate ? yen(r.corporate.net) : "";
  const tweetText = `${name}の利回り、公表と実質でこんなに違う📊\n公表 ${f2(nominalYield, 1)}% → 実質 ${realYieldPct}%（▼${diffPct}%）\nIRR（年率）${irrPct}%${netStr ? `｜税引後手取り ${netStr}` : ""}\n#FudoCalc #不動産クラファン`;

  const TaxRow = ({ label, t }) => (
    <div style={{ marginTop: 8, padding: 10, background: "#fafbfc", borderRadius: 8, border: "1px solid #e8ecf0" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", marginBottom: 6 }}>{label}（税率 {f2(t.rate * 100, 1)}%）</div>
      <div style={g}>
        <M label="配当金（税引前）" value={yen(r.profit)} />
        <M label="源泉徴収済（20.42%）" value={yen(t.withheld)} />
        <M label={t.diff >= 0 ? "確定申告時 追加納税" : "確定申告時 還付金"} value={yen(Math.abs(t.diff))} sub={t.diff < 0 ? "戻ってくる" : "追加支払い"} />
        <M label="手取り収益（税引後+特典）" value={yen(t.net)} accent />
      </div>
    </div>
  );

  return (
    <div style={S.sec}>
      <ShareCardSingle fund={fund} r={r} cardRef={cardRef} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: isMobile ? "wrap" : "nowrap" }}>
        <span style={{ background: "#1a3a5c", color: "#fff", width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>{index + 1}</span>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{name}</span>
        <span style={{ fontSize: 10, color: "#64748b" }}>拘束 {f2(r.totalDays, 0)}日（待機{r.waitD}日 + 運用{r.opDays}日 + 償還{r.retD}日）</span>
        <span style={{ marginLeft: "auto" }}>
          <ShareButton label={name} onCapture={handleCapture} tweetText={tweetText} />
        </span>
      </div>
      <div style={g}>
        <M label="公表利回り（年利）" value={`${f2(parseFloat(fund.yield), 1)}%`} tip="事業者がファンド詳細ページで表示している想定利回り（年利換算）。運用期間中の配当を年率に直した数値で、待機期間や税金は含まれていません。" />
        <M label="実質利回り（待機込）" value={`${f2(r.realYield * 100)}%`} accent tip="入金してから運用が始まるまでの待機期間を含めた利回り。資金が拘束されているのに利益を生まない期間を反映するため、公表利回りより低くなります。" />
        <M label="キャンペーン込み利回り" value={`${f2(r.campYield * 100)}%`} accent={r.campAmt > 0} tip="配当金にキャンペーン還元額を加算し、待機期間・償還待ちを含む総拘束期間で年率換算した利回り。ただし受取タイミングの時間価値は考慮しません。" />
        <M label="IRR（年率）" value={`${f2(r.irr * 100)}%`} accent tip="投資開始から償還完了まで、すべてのキャッシュフロー（投資・中間配当・キャンペーン還元・最終償還）の発生タイミングを考慮した年率リターン。お金の時間価値を反映した、最も正確な投資効率指標です。" />
      </div>
      {r.personal && <TaxRow label="👤 個人" t={r.personal} />}
      {r.corporate && <TaxRow label="🏢 法人" t={r.corporate} />}
    </div>
  );
}

// --- Comparison ---
function CompTable({ funds, tax }) {
  const rows = funds.map((f, i) => ({ name: f.name || `ファンド${i + 1}`, r: calc(f, tax), i })).filter(x => x.r);
  const compCardRef = useRef(null);
  if (rows.length < 2) return null;

  const bestOf = fn => { let b = 0; rows.forEach((x, i) => { if (fn(x.r) > fn(rows[b].r)) b = i; }); return b; };
  const bIRR = bestOf(r => r.irr || 0);
  const bReal = bestOf(r => r.realYield || 0);
  const bNet = bestOf(r => (r.personal?.net ?? r.corporate?.net ?? 0));

  const pct = (n, d = 2) => isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—";
  const yen = n => isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "—";
  const f2 = (n, d = 2) => isFinite(n) ? n.toFixed(d) : "—";

  const handleCompCapture = useCallback(async () => {
    await document.fonts.ready;
    const html2canvas = (await import("html2canvas")).default;
    return html2canvas(compCardRef.current, { width: 1200, height: 1200, scale: 1, useCORS: true, backgroundColor: null });
  }, []);

  const compTweetText = `ファンド比較してみた📊\n${rows.map(x => `${x.name}: IRR ${f2(x.r.irr * 100)}%`).join(" / ")}\n#FudoCalc #不動産クラファン`;

  return (
    <div style={S.sec}>
      <ShareCardComparison funds={funds} tax={tax} cardRef={compCardRef} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>⚖️ ファンド比較</h2>
        <ShareButton label="比較結果" onCapture={handleCompCapture} tweetText={compTweetText} />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f0f4f8" }}>
              {["ファンド", "公表利回り", "実質利回り", "CP込み", "IRR", "手取り収益"].map((h, i) => (
                <th key={i} style={{ padding: "8px 10px", textAlign: i ? "center" : "left", fontSize: 10.5, fontWeight: 600, color: "#64748b", borderBottom: "2px solid #e2e8f0" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => {
              const net = x.r.personal?.net ?? x.r.corporate?.net ?? 0;
              return (
                <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 600 }}>{x.name}</td>
                  <td style={{ padding: "9px 10px", textAlign: "center", ...S.mono }}>{pct(parseFloat(funds[x.i].yield) / 100, 1)}</td>
                  <td style={{ padding: "9px 10px", textAlign: "center", ...S.mono }}>
                    {i === bReal && <span style={S.tag("#dcfce7", "#166534")}>実質BEST</span>}{pct(x.r.realYield)}
                  </td>
                  <td style={{ padding: "9px 10px", textAlign: "center", ...S.mono }}>{pct(x.r.campYield)}</td>
                  <td style={{ padding: "9px 10px", textAlign: "center", ...S.mono, fontWeight: 700 }}>
                    {i === bIRR && <span style={S.tag("#1a3a5c", "#fff")}>IRR BEST</span>}{pct(x.r.irr)}
                  </td>
                  <td style={{ padding: "9px 10px", textAlign: "center", ...S.mono }}>
                    {i === bNet && <span style={S.tag("#fef3c7", "#92400e")}>手取BEST</span>}{yen(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- LLM Export ---
function LLMExport({ funds, tax }) {
  const [copied, setCopied] = useState(false);
  const f2 = (n, d = 2) => (n !== null && isFinite(n)) ? n.toFixed(d) : "—";
  const yen = n => isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "—";

  const text = useMemo(() => {
    const lines = ["# 不動産クラファン 実質利回り計算結果\n"];

    // Tax settings
    lines.push("## 税金設定");
    if (tax.entity === "personal" || tax.entity === "both") {
      if (tax.personalMode === "direct") {
        lines.push(`- 個人：実効税率 ${tax.personalDirect}%（直接入力）`);
      } else {
        const rate = getPersonalRate(parseFloat(tax.personalIncome) || 0);
        lines.push(`- 個人：課税所得 ${Number(tax.personalIncome).toLocaleString()}円 → 実効税率 ${(rate * 100).toFixed(1)}%`);
      }
    }
    if (tax.entity === "corporate" || tax.entity === "both") {
      lines.push(`- 法人：実効税率 ${tax.corpRate}%`);
    }
    lines.push("");

    funds.forEach((fund, idx) => {
      const r = calc(fund, tax);
      if (!r) return;
      const name = fund.name || `ファンド${idx + 1}`;
      lines.push(`## ${name}`);
      lines.push("");
      lines.push("### 入力条件");
      lines.push(`| 項目 | 値 |`);
      lines.push(`|---|---|`);
      lines.push(`| 想定利回り（年利） | ${fund.yield}% |`);
      lines.push(`| 運用期間 | ${fund.months}ヶ月 |`);
      lines.push(`| 投資予定額 | ${fund.amount}万円 |`);
      lines.push(`| 待機期間 | ${r.waitD}日${fund.waitMode === "date" ? `（${fund.waitDateStart} 〜 ${fund.waitDateEnd}）` : ""} |`);
      lines.push(`| 償還待ち | ${r.retD}日${fund.returnMode === "date" ? `（${fund.returnDateStart} 〜 ${fund.returnDateEnd}）` : ""} |`);
      lines.push(`| 総資金拘束日数 | ${r.totalDays}日 |`);

      // Campaigns
      const activeCamps = fund.campaigns.filter(c => c.enabled);
      if (activeCamps.length > 0) {
        activeCamps.forEach((c, ci) => {
          const val = c.type === "fixed" ? `${Number(c.value).toLocaleString()}円` : `投資額の${c.value}%`;
          const delay = c.delayDays ? `（${c.delayDays}日後付与）` : "";
          lines.push(`| キャンペーン${ci + 1} | ${val}${delay} |`);
        });
      }

      // Dividend schedule
      const activeDivs = (fund.dividends || []).filter(d => d.enabled);
      if (activeDivs.length > 0) {
        activeDivs.forEach((d, di) => {
          const val = d.type === "fixed" ? `${Number(d.value).toLocaleString()}円` : `投資額の${d.value}%`;
          lines.push(`| 中間配当${di + 1} | ${d.months}ヶ月後に${val} |`);
        });
      }
      lines.push("");

      lines.push("### 計算結果");
      lines.push(`| 指標 | 値 |`);
      lines.push(`|---|---|`);
      lines.push(`| 公表利回り | ${fund.yield}% |`);
      lines.push(`| 実質利回り（待機込） | ${f2(r.realYield * 100)}% |`);
      lines.push(`| キャンペーン込み利回り | ${f2(r.campYield * 100)}% |`);
      lines.push(`| IRR（年率） | ${r.irr !== null ? f2(r.irr * 100) : "—"}% |`);
      lines.push(`| 配当金（税引前） | ${yen(r.profit)} |`);

      if (r.personal) {
        lines.push(`| 【個人】実効税率 | ${f2(r.personal.rate * 100, 1)}% |`);
        lines.push(`| 【個人】源泉徴収済 | ${yen(r.personal.withheld)} |`);
        lines.push(`| 【個人】確定申告時 ${r.personal.diff >= 0 ? "追加納税" : "還付金"} | ${yen(Math.abs(r.personal.diff))} |`);
        lines.push(`| 【個人】手取り収益 | ${yen(r.personal.net)} |`);
      }
      if (r.corporate) {
        lines.push(`| 【法人】実効税率 | ${f2(r.corporate.rate * 100, 1)}% |`);
        lines.push(`| 【法人】手取り収益 | ${yen(r.corporate.net)} |`);
      }
      lines.push("");
    });

    return lines.join("\n");
  }, [funds, tax]);

  const handleCopy = () => {
    trackEvent("copy_llm_export", { fund_count: funds.length });
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div style={S.sec}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>🤖 LLMに情報連携する</h2>
        <button onClick={handleCopy} style={{ ...S.btn, background: copied ? "#059669" : "#1a3a5c", fontSize: 11, padding: "5px 12px" }}>
          {copied ? "✓ コピーしました" : "📋 クリップボードにコピー"}
        </button>
      </div>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>計算条件と結果をマークダウン形式でコピーできます。ChatGPT・Claude等のAIに貼り付けて、投資判断の相談にお使いください。</div>
      <pre style={{
        background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: 12,
        fontSize: 10.5, lineHeight: 1.6, color: "#334155", overflow: "auto", maxHeight: 300,
        fontFamily: "'DM Mono', monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0
      }}>{text}</pre>
    </div>
  );
}
const mkFund = (name) => ({
  name, yield: "6.0", months: "12", amount: "100",
  waitMode: "date", waitDays: "14", waitDateStart: "", waitDateEnd: "",
  returnMode: "date", returnDays: "30", returnDateStart: "", returnDateEnd: "",
  campaigns: [{ ...EMPTY_CAMP }, { ...EMPTY_CAMP }, { ...EMPTY_CAMP }],
  showCampaign: false,
  dividends: Array.from({ length: 10 }, () => ({ ...EMPTY_DIV })),
  showDividends: false,
});

export default function App() {
  const isMobile = useIsMobile();
  const [tax, setTax] = useState({ entity: "personal", personalMode: "income", personalIncome: "5000000", personalDirect: "30", corpRate: "25" });
  const [funds, setFunds] = useState([mkFund("ファンドA")]);

  const add = () => { if (funds.length < 5) { trackEvent("add_fund", { fund_count: funds.length + 1 }); setFunds([...funds, mkFund(`ファンド${String.fromCharCode(65 + funds.length)}`)]); } };
  const rm = i => setFunds(funds.filter((_, j) => j !== i));
  const up = (i, f) => setFunds(funds.map((fd, j) => j === i ? f : fd));
  const cp = i => { if (i > 0) setFunds(funds.map((fd, j) => j === i ? { ...JSON.parse(JSON.stringify(funds[i - 1])), name: `${funds[i - 1].name}（コピー）` } : fd)); };

  return (
    <div style={S.page}>
      {/* Fonts loaded in index.html for render-blocking prevention */}
      <header style={S.hdr}>
        <div style={S.wrap}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 600, background: "rgba(255,255,255,0.15)", padding: "2px 8px", borderRadius: 4 }}>BETA</span>
            <h1 style={{ fontSize: isMobile ? 14 : 17, fontWeight: 700, margin: 0 }}>FudoCalc - 不動産クラウドファンディング実質利回り計算機</h1>
          </div>
          <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>待機期間・キャンペーン・税金（個人/法人）を考慮した実質利回り・IRRを算出。複数ファンドの比較も可能。</p>
        </div>
      </header>

      <main style={{ ...S.wrap, padding: "14px 12px 40px" }}>
        <TaxPanel tax={tax} onChange={setTax} isMobile={isMobile} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>📋 ファンド情報</h2>
          {funds.length < 5 && <button onClick={add} style={S.btn}>＋ ファンド追加（{funds.length}/5）</button>}
        </div>

        {funds.map((f, i) => <FundInput key={i} fund={f} index={i} onUpdate={up} onRemove={rm} onCopy={cp} canRemove={funds.length > 1} isFirst={i === 0} isMobile={isMobile} />)}

        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "18px 0 8px" }}>📊 計算結果</h2>
        {funds.map((f, i) => <ErrorBoundary key={i}><FundResult fund={f} index={i} tax={tax} isMobile={isMobile} /></ErrorBoundary>)}

        <ErrorBoundary><CompTable funds={funds} tax={tax} /></ErrorBoundary>
        <LLMExport funds={funds} tax={tax} />

        <div style={{ ...S.sec, fontSize: 11, color: "#64748b", lineHeight: 1.7 }}>
          <h2 style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginTop: 0, marginBottom: 8 }}>📖 計算ロジック・注意事項</h2>

          <h3 style={{ fontSize: 11, fontWeight: 700, color: "#475569", margin: "0 0 4px" }}>各指標の定義</h3>
          <p style={{ margin: "0 0 5px" }}><strong>公表利回り（年利）：</strong>事業者がファンド詳細ページで表示している想定利回り。運用期間中に得られる配当を年率換算した数値です。入金から運用開始までの待機期間、運用終了後の償還待ち、税金、キャンペーン還元は含まれていません。</p>
          <p style={{ margin: "0 0 5px" }}><strong>実質利回り（待機込）：</strong>入金してから運用が始まるまでの待機期間を加味した利回り。計算式は「公表利回り × 運用日数 ÷（待機日数＋運用日数）」です。資金が拘束されているのに利益を生まない期間を反映するため、公表利回りより低くなります。</p>
          <p style={{ margin: "0 0 5px" }}><strong>キャンペーン込み利回り：</strong>配当金にキャンペーン還元額（ギフト券・ポイント等）を加算し、待機期間・運用期間・償還待ちを含む総拘束期間で年率換算した利回りです。「最終的にいくら戻ってきたか」の総額ベースの指標であり、受取タイミングの時間価値は考慮しません。</p>
          <p style={{ margin: "0 0 10px" }}><strong>IRR（内部収益率）：</strong>投資開始から償還完了まで、すべてのキャッシュフロー（投資・中間配当・キャンペーン還元・最終償還）の発生タイミングを考慮した年率リターンです。同じ金額でも早く受け取れるほうが再投資に回せるため価値が高い、という「お金の時間価値」を反映しており、複数ファンドの投資効率を最も公平に比較できる指標です。</p>

          <h3 style={{ fontSize: 11, fontWeight: 700, color: "#475569", margin: "0 0 4px" }}>その他</h3>
          <p style={{ margin: "0 0 5px" }}><strong>税区分：</strong>匿名組合型の分配金は「雑所得」（総合課税）。源泉徴収20.42%は仮払いで、確定申告にて精算。課税所得695万円未満なら還付、超なら追加納税の可能性があります。</p>
          <p style={{ margin: "0 0 5px" }}><strong>法人：</strong>法人税率が適用。高所得個人より有利になるケースがあります。</p>
          <p style={{ margin: "0 0 5px" }}><strong>キャンペーン：</strong>還元額は非課税として計算しています（一時所得の50万円特別控除内を想定）。</p>
          <p style={{ margin: "0 0 5px" }}><strong>配当スケジュール：</strong>中間配当を設定すると、そのタイミングでのキャッシュフローとしてIRR計算に反映されます。中間配当額は最終償還時の配当から差し引かれます。設定しない場合は、運用終了時に一括配当されるものとして計算します。</p>
          <p style={{ margin: 0 }}><strong>資金遊休期間の比較：</strong>「入金日 / 資金確保日」に手元資金が空いた日を入力すれば、資金の遊休期間も含めた投資効率の比較が可能です。複数ファンドで同じ日を起算点にすることで、フェアな比較ができます。</p>
        </div>

        <div style={{ ...S.sec, fontSize: 10, color: "#5a6a7e", lineHeight: 1.7, background: "#fafbfc" }}>
          <h2 style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginTop: 0, marginBottom: 6 }}>⚠️ 免責事項</h2>
          <p style={{ margin: "0 0 4px" }}>本ツールは、不動産クラウドファンディングへの投資検討にあたっての参考情報を提供するものであり、特定のファンドや事業者への投資を推奨するものではありません。</p>
          <p style={{ margin: "0 0 4px" }}>表示される計算結果は、ユーザーが入力した数値に基づく試算であり、実際の投資成果を保証するものではありません。利回りや運用期間は変動する可能性があります。</p>
          <p style={{ margin: "0 0 4px" }}>税金に関する計算は簡易的なシミュレーションであり、税務アドバイスには該当しません。実際の確定申告や税務判断については、税理士等の専門家にご相談ください。</p>
          <p style={{ margin: 0 }}>投資にあたっては、各事業者の公式サイトで最新のファンド情報・契約条件・リスク説明を必ずご確認の上、ご自身の判断と責任において行ってください。</p>
        </div>
      </main>

      <footer style={{ textAlign: "center", padding: "16px 0 24px", fontSize: 11, color: "#64748b" }}>
        © 2026 FudoCalc
      </footer>
    </div>
  );
}
