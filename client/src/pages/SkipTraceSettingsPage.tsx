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
import CircularProgress from "@mui/material/CircularProgress";
import SaveIcon from "@mui/icons-material/Save";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { api, ApiError } from "../api";
import { SkipTraceCostView, SkipTracePromptView } from "../types";

/**
 * Skip-Trace Settings (JAK-136). Any logged-in admin can tune the STYLE prompt the
 * skip-trace specialist uses to phrase owner/contact replies, and the credit COST
 * of one skip trace. The HARD guardrails (no emojis, only-provided-values, the
 * GoTextJake.com footer) are enforced by the server no matter what is typed here —
 * surfaced as a note so the operator knows an edit here can't make Jake invent
 * contact info or drop the footer.
 */
export function SkipTraceSettingsPage() {
  const [view, setView] = useState<SkipTracePromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [cost, setCost] = useState<SkipTraceCostView | null>(null);
  const [costDraft, setCostDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [savingCost, setSavingCost] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, c] = await Promise.all([api.getSkipTracePrompt(), api.getSkipTraceCost()]);
      setView(v);
      setDraft(v.prompt);
      setCost(c);
      setCostDraft(String(c.value));
    } catch {
      setError("Couldn't load the skip-trace settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = view !== null && draft.trim() !== view.prompt.trim();
  const costDirty = cost !== null && costDraft.trim() !== String(cost.value);

  async function save() {
    if (!draft.trim()) {
      setError("The prompt can't be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const v = await api.updateSkipTracePrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt saved. New skip traces use it right away.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the prompt.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setError(null);
    setResetting(true);
    try {
      const v = await api.resetSkipTracePrompt();
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt reset to the default.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the prompt.");
    } finally {
      setResetting(false);
    }
  }

  async function saveCost() {
    const credits = Number(costDraft);
    if (!Number.isInteger(credits) || credits <= 0) {
      setError("The skip-trace cost must be a whole number of credits, at least 1.");
      return;
    }
    setError(null);
    setSavingCost(true);
    try {
      const c = await api.updateSkipTraceCost(credits);
      setCost(c);
      setCostDraft(String(c.value));
      setToast("Skip-trace cost saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the cost.");
    } finally {
      setSavingCost(false);
    }
  }

  if (view === null && error === null) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>
          Skip-Trace
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Skip trace finds the <strong>owner's contact info</strong> (phone, email, mailing address)
        for a property. This controls how Jake phrases that reply, and how many credits one trace
        costs. Traces are confirmed before spending — Jake quotes the price and waits for an OK.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake still uses only the contact values the trace returned,
        never invents a name or number, sends no emojis, and ends with the GoTextJake.com footer.
        These guardrails are enforced by the server and can’t be edited away.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
          Cost per skip trace
        </Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
          <TextField
            label="Credits"
            type="number"
            value={costDraft}
            onChange={(e) => setCostDraft(e.target.value)}
            disabled={savingCost}
            inputProps={{ min: 1, step: 1 }}
            sx={{ width: 160 }}
          />
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={saveCost}
            disabled={!costDirty || savingCost}
          >
            {savingCost ? "Saving…" : "Save cost"}
          </Button>
          {cost && cost.isDefault && <Chip size="small" variant="outlined" label="Default" />}
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
          Reply style
        </Typography>
        <TextField
          label="Skip-trace prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={12}
          fullWidth
          disabled={saving || resetting}
          placeholder="Describe how Jake should phrase the owner's contact info…"
        />

        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{ mt: 2, alignItems: { sm: "center" } }}
        >
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={save}
            disabled={!dirty || saving || resetting}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={resetToDefault}
            disabled={saving || resetting || view?.isDefault}
          >
            {resetting ? "Resetting…" : "Reset to default"}
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          {view && !view.isDefault && view.updatedAt && (
            <Typography variant="caption" color="text.secondary">
              Last edited {new Date(view.updatedAt).toLocaleString()}
            </Typography>
          )}
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
