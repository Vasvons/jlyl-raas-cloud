import ShareClient from './ShareClient';

// 静态导出模式需要此函数，返回占位路径以满足构建要求，实际 token 由客户端路由处理
export function generateStaticParams() {
  return [{ token: 'placeholder' }];
}

export default function SharePage({ params }: { params: { token: string } }) {
  return <ShareClient token={params.token} />;
}
