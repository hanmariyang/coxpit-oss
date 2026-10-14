// 커널이 쓰는 데이터 모양만. 여기에 동작을 두지 않는다.

/** 명령을 실행할 기계. 로컬이면 kind='local' 또는 address=''. */
export interface MachineTarget {
  slug: string;
  kind: string;
  address: string;
  sshUser: string;
}

export function isLocalMachine(m: MachineTarget): boolean {
  return m.kind === 'local' || m.address === '';
}
