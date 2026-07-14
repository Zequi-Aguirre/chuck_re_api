import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small yes/no confirmation for deactivate / delete actions. */
export function ConfirmDialog({ open, title, body, confirmLabel, destructive, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{body}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color={destructive ? "error" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
