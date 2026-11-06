import { useParams } from 'react-router';

import { BenchWorkbench } from '@/modules/schematic/BenchWorkbench';

export default function BenchGraphRoute(): React.ReactElement {
  const { graphId = '' } = useParams();
  return <BenchWorkbench key={graphId} graphId={graphId} />;
}
