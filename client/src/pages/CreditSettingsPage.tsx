import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import CircularProgress from "@mui/material/CircularProgress";
import SaveIcon from "@mui/icons-material/Save";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { api, ApiError } from "../api";
import { CreditDefaultView, CreditType, OutOfCreditsMessageView } from "../types";
import { CREDIT_TYPES, creditTypeLabel } from "./creditsLayout";

/**
 * Credits settings (JAK-162) — the admin surface over the per-feature credit
 * buckets JAK-161 added. Two sections, both session-guarded, no secrets:
 *
 *  1. NEW-CUSTOMER default grants — how many credits a brand-new texter is seeded
 *     with in each bucket (report / skiptrace / comps). 0 is valid (a paid
 *     feature can start empty).
 *  2. OUT-OF-CREDITS messages — the reply Jake sends when a bucket runs dry, per
 *     bucket. The GoTextJake.com footer (JAK-158) is always appended by the
 *     sender, so it is never part of the message you type here.
 *
 * MOBILE-FIRST (standing rule — Zequi runs the dash on his phone): every row
 * stacks on a phone (column → row at the sm breakpoint) so nothing scrolls off.
 * Mirrors the accepted editable-prompt pattern (load / save / reset per item).
 */
export function CreditSettingsPage() {
  const [defaults, setDefaults] = useState<CreditDefaultView[] | null>(null);
  const [messages, setMessages] = useState<OutOfCreditsMessageView[] | null>(null);
  // Per-bucket edit drafts, keyed by credit type.
  const [amountDraft, setAmountDraft] = useState<Record<CreditType, string>>(emptyDraft());
  const [messageDraft, setMessageDraft] = useState<Record<CreditType, string>>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The type whose amount / message save is in flight, so we disable just that row.
  const [savingAmount, setSavingAmount] = useState<CreditType | null>(null);
  const [savingMessage, setSavingMessage] = useState<CreditType | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, m] = await Promise.all([api.getCreditDefaults(), api.getOutOfCreditsMessages()]);
      setDefaults(d);
      setMessages(m);
      setAmountDraft(byType(d, (v) => String(v.value)));
      setMessageDraft(byType(m, (v) => v.value));
    } catch {
      setError("Couldn't load the credit settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const defaultOf = (type: CreditType) => defaults?.find((d) => d.type === type) ?? null;
  const messageOf = (type: CreditType) => messages?.find((m) => m.type === type) ?? null;

  async function saveAmount(type: CreditType) {
    const credits = Number(amountDraft[type]);
    if (!Number.isInteger(credits) || credits < 0) {
      setError(`The ${creditTypeLabel(type).toLowerCase()} default must be a whole number of credits (0 or more).`);
      return;
    }
    setError(null);
    setSavingAmount(type);
    try {
      const view = await api.updateCreditDefault(type, credits);
      setDefaults((prev) => replace(prev, view));
      setAmountDraft((prev) => ({ ...prev, [type]: String(view.value) }));
      setToast(`${creditTypeLabel(type)} default grant saved.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the default grant.");
    } finally {
      setSavingAmount(null);
    }
  }

  async function resetAmount(type: CreditType) {
    setError(null);
    setSavingAmount(type);
    try {
      const view = await api.resetCreditDefault(type);
      setDefaults((prev) => replace(prev, view));
      setAmountDraft((prev) => ({ ...prev, [type]: String(view.value) }));
      setToast(`${creditTypeLabel(type)} default grant reset to the default.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the default grant.");
    } finally {
      setSavingAmount(null);
    }
  }

  async function saveMessage(type: CreditType) {
    if (!messageDraft[type].trim()) {
      setError(`The ${creditTypeLabel(type).toLowerCase()} out-of-credits message can't be empty.`);
      return;
    }
    setError(null);
    setSavingMessage(type);
    try {
      const view = await api.updateOutOfCreditsMessage(type, messageDraft[type]);
      setMessages((prev) => replace(prev, view));
      setMessageDraft((prev) => ({ ...prev, [type]: view.value }));
      setToast(`${creditTypeLabel(type)} out-of-credits message saved.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the message.");
    } finally {
      setSavingMessage(null);
    }
  }

  async function resetMessage(type: CreditType) {
    setError(null);
    setSavingMessage(type);
    try {
      const view = await api.resetOutOfCreditsMessage(type);
      setMessages((prev) => replace(prev, view));
      setMessageDraft((prev) => ({ ...prev, [type]: view.value }));
      setToast(`${creditTypeLabel(type)} out-of-credits message reset to the default.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the message.");
    } finally {
      setSavingMessage(null);
    }
  }

  if (defaults === null && messages === null && error === null) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Typography variant="h5" fontWeight={800} sx={{ mb: 1 }}>
        Credits
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Each text customer has three independent credit buckets — <strong>report</strong>,{" "}
        <strong>skip-trace</strong>, and <strong>comps</strong>. Set how many credits a brand-new
        customer starts with in each, and the reply Jake sends when a bucket runs out. To top up an
        existing customer, use “Grant credits” on the Text customers page.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Section 1 — new-customer default grants (JAK-162). */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
          New-customer default grants
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Credits a new customer is seeded with in each bucket. 0 is allowed (a paid feature can
          start empty).
        </Typography>
        <Stack spacing={2} divider={<Divider flexItem />}>
          {CREDIT_TYPES.map((type) => {
            const view = defaultOf(type);
            const dirty = view !== null && amountDraft[type].trim() !== String(view.value);
            const busy = savingAmount === type;
            return (
              <Stack
                key={type}
                direction={{ xs: "column", sm: "row" }}
                spacing={1.5}
                sx={{ alignItems: { sm: "center" } }}
              >
                <Typography sx={{ minWidth: 120, fontWeight: 600 }}>{creditTypeLabel(type)}</Typography>
                <TextField
                  label="Credits"
                  type="number"
                  value={amountDraft[type]}
                  onChange={(e) => setAmountDraft((prev) => ({ ...prev, [type]: e.target.value }))}
                  disabled={busy}
                  inputProps={{ min: 0, step: 1 }}
                  sx={{ width: { xs: "100%", sm: 160 } }}
                />
                <Button
                  variant="contained"
                  startIcon={<SaveIcon />}
                  onClick={() => saveAmount(type)}
                  disabled={!dirty || busy}
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<RestartAltIcon />}
                  onClick={() => resetAmount(type)}
                  disabled={busy || view?.isDefault}
                >
                  Reset
                </Button>
                {view?.isDefault ? (
                  <Chip size="small" variant="outlined" label="Default" />
                ) : (
                  <Chip size="small" color="primary" label="Customized" />
                )}
              </Stack>
            );
          })}
        </Stack>
      </Paper>

      {/* Section 2 — out-of-credits messages (JAK-162). */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
          Out-of-credits messages
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          What Jake replies when a customer&apos;s bucket is empty — one message per feature.
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Footer added automatically</AlertTitle>
          The GoTextJake.com/crm footer is always appended by Jake — don&apos;t include it here.
        </Alert>
        <Stack spacing={3}>
          {CREDIT_TYPES.map((type) => {
            const view = messageOf(type);
            const dirty = view !== null && messageDraft[type].trim() !== view.value.trim();
            const busy = savingMessage === type;
            return (
              <Box key={type}>
                <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
                  <Typography sx={{ fontWeight: 600, flexGrow: 1 }}>{creditTypeLabel(type)}</Typography>
                  {view?.isDefault ? (
                    <Chip size="small" variant="outlined" label="Default" />
                  ) : (
                    <Chip size="small" color="primary" label="Customized" />
                  )}
                </Box>
                <TextField
                  label={`${creditTypeLabel(type)} out-of-credits message`}
                  value={messageDraft[type]}
                  onChange={(e) => setMessageDraft((prev) => ({ ...prev, [type]: e.target.value }))}
                  multiline
                  minRows={2}
                  fullWidth
                  disabled={busy}
                  placeholder={`What Jake says when a customer is out of ${creditTypeLabel(type).toLowerCase()} credits…`}
                />
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1.5}
                  sx={{ mt: 1.5, alignItems: { sm: "center" } }}
                >
                  <Button
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={() => saveMessage(type)}
                    disabled={!dirty || busy}
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<RestartAltIcon />}
                    onClick={() => resetMessage(type)}
                    disabled={busy || view?.isDefault}
                  >
                    Reset to default
                  </Button>
                  <Box sx={{ flexGrow: 1 }} />
                  {view && !view.isDefault && view.updatedAt && (
                    <Typography variant="caption" color="text.secondary">
                      Last edited {new Date(view.updatedAt).toLocaleString()}
                    </Typography>
                  )}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </Paper>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}

/** A fresh empty per-bucket draft map. */
function emptyDraft(): Record<CreditType, string> {
  return { report: "", skiptrace: "", comps: "" };
}

/** Build a per-bucket draft map from a list of typed views + a value picker. */
function byType<T extends { type: CreditType }>(
  views: T[],
  pick: (v: T) => string
): Record<CreditType, string> {
  const out = emptyDraft();
  for (const v of views) out[v.type] = pick(v);
  return out;
}

/** Swap the matching-type view in a list for its updated copy (immutably). */
function replace<T extends { type: CreditType }>(list: T[] | null, next: T): T[] {
  if (!list) return [next];
  return list.map((v) => (v.type === next.type ? next : v));
}
