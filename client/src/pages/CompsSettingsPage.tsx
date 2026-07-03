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
import { ModelPickerSection } from "../components/ModelPickerSection";
import { CompParams, CompsCostView, CompsParamsView, CompsPromptView } from "../types";

/** The editable default comp parameters, with labels + input hints for the form. */
const PARAM_FIELDS: { key: keyof CompParams; label: string; helper: string; step?: number }[] = [
  { key: "radiusMiles", label: "Search radius (miles)", helper: "0.1 – 10", step: 0.1 },
  { key: "count", label: "Number of comps", helper: "1 – 10", step: 1 },
  { key: "monthsBack", label: "Timeframe (months)", helper: "1 – 24", step: 1 },
  { key: "bedsTolerance", label: "Beds tolerance (±)", helper: "0 – 3", step: 1 },
  { key: "bathsTolerance", label: "Baths tolerance (±)", helper: "0 – 3", step: 1 },
  { key: "sqftTolerancePct", label: "Sqft tolerance (%)", helper: "0 – 100", step: 1 },
];

/**
 * Comps Settings (JAK-137). Any logged-in admin can tune the STYLE prompt the comps
 * specialist uses to phrase comparable-sales replies, how many credits one comps
 * pull costs, and the DEFAULT comp parameters (radius, number of comps, timeframe,
 * bed/bath/sqft tolerance) used when a texter doesn't specify their own. The HARD
 * guardrails (no emojis, only-provided-values, the GoTextJake.com footer) are
 * enforced by the server no matter what is typed here.
 */
export function CompsSettingsPage() {
  const [view, setView] = useState<CompsPromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [cost, setCost] = useState<CompsCostView | null>(null);
  const [costDraft, setCostDraft] = useState("");
  const [params, setParams] = useState<CompsParamsView | null>(null);
  const [paramsDraft, setParamsDraft] = useState<Record<keyof CompParams, string>>({} as Record<keyof CompParams, string>);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [savingCost, setSavingCost] = useState(false);
  const [savingParams, setSavingParams] = useState(false);

  const paramsToDraft = (p: CompParams): Record<keyof CompParams, string> =>
    PARAM_FIELDS.reduce(
      (acc, f) => ({ ...acc, [f.key]: String(p[f.key]) }),
      {} as Record<keyof CompParams, string>
    );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, c, p] = await Promise.all([
        api.getCompsPrompt(),
        api.getCompsCost(),
        api.getCompsParams(),
      ]);
      setView(v);
      setDraft(v.prompt);
      setCost(c);
      setCostDraft(String(c.value));
      setParams(p);
      setParamsDraft(paramsToDraft(p.params));
    } catch {
      setError("Couldn't load the comps settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = view !== null && draft.trim() !== view.prompt.trim();
  const costDirty = cost !== null && costDraft.trim() !== String(cost.value);
  const paramsDirty =
    params !== null && PARAM_FIELDS.some((f) => paramsDraft[f.key]?.trim() !== String(params.params[f.key]));

  async function save() {
    if (!draft.trim()) {
      setError("The prompt can't be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const v = await api.updateCompsPrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt saved. New comps pulls use it right away.");
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
      const v = await api.resetCompsPrompt();
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
      setError("The comps cost must be a whole number of credits, at least 1.");
      return;
    }
    setError(null);
    setSavingCost(true);
    try {
      const c = await api.updateCompsCost(credits);
      setCost(c);
      setCostDraft(String(c.value));
      setToast("Comps cost saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the cost.");
    } finally {
      setSavingCost(false);
    }
  }

  async function saveParams() {
    const next = {} as CompParams;
    for (const f of PARAM_FIELDS) {
      const value = Number(paramsDraft[f.key]);
      if (!Number.isFinite(value)) {
        setError(`${f.label} must be a number.`);
        return;
      }
      next[f.key] = value;
    }
    setError(null);
    setSavingParams(true);
    try {
      const p = await api.updateCompsParams(next);
      setParams(p);
      setParamsDraft(paramsToDraft(p.params));
      setToast("Default comp parameters saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the parameters.");
    } finally {
      setSavingParams(false);
    }
  }

  async function resetParamsToDefault() {
    setError(null);
    setSavingParams(true);
    try {
      const p = await api.resetCompsParams();
      setParams(p);
      setParamsDraft(paramsToDraft(p.params));
      setToast("Parameters reset to the default.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the parameters.");
    } finally {
      setSavingParams(false);
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
          Comps
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Comps pull <strong>comparable sales</strong> near a property. This controls how Jake phrases
        that reply, how many credits one pull costs, and the default search parameters (radius, number
        of comps, timeframe, bed/bath/sqft tolerance). A texter can override the parameters in their
        message. Comps are confirmed before spending — Jake quotes the price and parameters and waits
        for an OK.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake still uses only the comps the data returned, never invents
        a comp or a price, sends no emojis, and ends with the GoTextJake.com footer. These guardrails
        are enforced by the server and can’t be edited away.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ModelPickerSection
        load={api.getCompsModel}
        save={api.updateCompsModel}
        reset={api.resetCompsModel}
        onToast={setToast}
        onError={setError}
      />

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
          Cost per comps pull
        </Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
          <TextField
            label="Credits"
            type="number"
            value={costDraft}
            onChange={(e) => setCostDraft(e.target.value)}
            disabled={savingCost}
            inputProps={{ min: 1, step: 1 }}
            sx={{ width: { xs: "100%", sm: 160 } }}
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

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
            Default comp parameters
          </Typography>
          {params && params.isDefault && <Chip size="small" variant="outlined" label="Default" />}
        </Box>
        <Stack direction="row" flexWrap="wrap" gap={1.5} sx={{ mb: 2 }}>
          {PARAM_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              helperText={f.helper}
              type="number"
              value={paramsDraft[f.key] ?? ""}
              onChange={(e) => setParamsDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              disabled={savingParams}
              inputProps={{ step: f.step ?? 1 }}
              sx={{ width: { xs: "100%", sm: 200 } }}
            />
          ))}
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={saveParams}
            disabled={!paramsDirty || savingParams}
          >
            {savingParams ? "Saving…" : "Save parameters"}
          </Button>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={resetParamsToDefault}
            disabled={savingParams || params?.isDefault}
          >
            Reset to default
          </Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
          Reply style
        </Typography>
        <TextField
          label="Comps prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={12}
          fullWidth
          disabled={saving || resetting}
          placeholder="Describe how Jake should phrase the comparable-sales summary…"
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
