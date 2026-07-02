import Chip from "@mui/material/Chip";
import { ConnectionStatus } from "../types";

/** Consistent active/inactive badge for a connection's status. */
export function StatusChip({ status }: { status: ConnectionStatus }) {
  return (
    <Chip
      size="small"
      label={status}
      color={status === "active" ? "success" : "default"}
      variant={status === "active" ? "filled" : "outlined"}
    />
  );
}
