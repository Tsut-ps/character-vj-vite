import {
  commandAllowed,
  DEFAULT_REMOTE_PERMISSIONS,
  type RemoteCommand,
  type RemoteEnvelope,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol.ts";

/** controllerのpermissionと単調増加seqを送信処理から分離して管理する */
export class ControllerCommandSender {
  private readonly sendEnvelope: (envelope: RemoteEnvelope) => boolean;
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private seq = 0;

  /** 検証済みenvelopeを送る関数へcontroller commandを接続する */
  constructor(sendEnvelope: (envelope: RemoteEnvelope) => boolean) {
    this.sendEnvelope = sendEnvelope;
  }

  /** serverから確定したpermissionへ更新する */
  setPermissions(permissions: RemotePermissions): void {
    this.permissions = { ...permissions };
  }

  /** 許可済みcommandを送信成功時だけ次のseqへ進める */
  send(command: RemoteCommand): boolean {
    if (!commandAllowed(command, this.permissions)) return false;
    const envelope: RemoteEnvelope = { v: 1, seq: this.seq, command };
    if (!this.sendEnvelope(envelope)) return false;
    this.seq += 1;
    return true;
  }
}
