import { Outlet } from 'react-router';

export function meta(): { title: string }[] {
  return [{ title: 'Incident benches · TraceBench' }];
}

export default function BenchLayout(): React.ReactElement {
  return <Outlet />;
}
