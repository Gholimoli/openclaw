export type TelegramWorkApprovalButtonRow = Array<{ text: string; callback_data: string }>;

export function buildTelegramWorkApprovalButtons(): TelegramWorkApprovalButtonRow[] {
  return [
    [
      {
        text: "Approve",
        callback_data: "xwk1:y",
      },
      {
        text: "Deny",
        callback_data: "xwk1:n",
      },
    ],
  ];
}
