'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Spin, Pagination, Radio, Select, Row, Col, Flex, Button, Modal, message } from 'antd';
import ReactECharts from 'echarts-for-react';
import api from '@/lib/api';
import { useRouter } from 'next/navigation';
import styles from './dashboard.module.css';

const IMG = 'https://static.7asi.com/assets/reportGeo';

// 平台图标映射（与 7asi 参考页一致）
const PLATFORM_ICONS: Record<string, string> = {
  '豆包': 'https://static.7asi.com/assets/GeoYy/Frame%20(2).png',
  '文心一言': 'https://static.7asi.com/assets/GeoYy/Frame%20(3).png',
  'DeepSeek': 'https://static.7asi.com/assets/GeoYy/Vector.png',
  'Kimi': 'https://static.7asi.com/assets/GeoYy/Frame.png',
  '腾讯元宝': 'https://static.7asi.com/assets/GeoYy/Frame%20(4).png',
  '通义千问': 'https://static.7asi.com/assets/GeoYy/Frame%20(1).png',
  '百度AI': 'https://static.7asi.com/assets/GeoYy/baiduai.png',
  '纳米': 'https://static.7asi.com/assets/GeoYy/nm.png',
};

interface StatsData {
  total: number;
  count: number;
  zlgjc: number;
  ppgjc: number;
}

interface PlatformRatioItem {
  platform: string;
  count: number;
}

interface KeywordCountItem {
  distillateKeyword: string;
  count: number;
}

interface SearchRankItem {
  id: number;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  queryTime: string;
  url: string;
  zlgjcUrl?: string;
}

interface LoginUser {
  id: string;
  username: string;
  phone: string;
  email: string;
  url: string;
  dateTime: string;
  password?: string;
  address?: string;
  level?: string;
  cid?: string;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

// AI名片组件
function AICard({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [user, setUser] = useState<LoginUser>({ id: '-1', username: '', phone: '-', url: '', email: '-', password: '', address: '', level: '', cid: '', dateTime: '' });

  useEffect(() => {
    if (!userId) {
      setUser({ id: '-1', username: '', phone: '-', url: '', email: '-', password: '', address: '', level: '', cid: '', dateTime: '' });
      return;
    }
    (async () => {
      const res = await api.get('/users/getLoginUser', { params: { userId } });
      if (res.data?.code === 200) {
        const d = res.data.data;
        let phone = d.phone ? String(d.phone) : '-';
        if (Number(phone) === Number(d.phone)) {
          phone = phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
        }
        setUser({ ...d, phone: d.phone ? phone : '-', email: d.email ? d.email : '-' });
      }
    })();
  }, [userId]);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.aiCardHeader} ${isMobile ? styles.aiMobile : styles.aiPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Profile.png`} alt="" />
          </div>
          <div className={styles.aiTitle}>{user.username}</div>
        </div>
      }
      className={`${styles.gCard} ${styles.aiWrapper} ${isMobile ? styles.aiMobile : styles.aiPc}`}
    >
      {isMobile ? (
        <Row className={styles.aiBaseInfo}>
          <Col className={styles.aiLeft} span={8}>
            <div className={styles.aiFWrapper}>
              <div className={styles.aiFIcon}>
                <img src={`${IMG}/256x256.png`} alt="" />
              </div>
              <div className={styles.aiFTitle}>AI名片</div>
            </div>
          </Col>
          <Col className={styles.aiRight} span={16}>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235607.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>电话:{user.phone}</div>
            </div>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235605.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>邮箱:{user.email}</div>
            </div>
            <div className={styles.aiItem}>
              <div className={styles.aiItemIcon}>
                <img src={`${IMG}/Frame_2037235606.png`} alt="" />
              </div>
              <div className={styles.aiItemTitle}>网址:{user.url ? <a href={user.url} target="_blank">{user.url}</a> : '-'}</div>
            </div>
          </Col>
        </Row>
      ) : (
        <Row className={styles.aiBaseInfo}>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiFIcon}>
                  <img src={`${IMG}/256x256.png`} alt="" />
                </div>
                <div className={styles.aiFTitle}>AI名片</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235607.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>电话</div>
                <div className={styles.aiItemContent}>{user.phone}</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235605.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>邮箱</div>
                <div className={styles.aiItemContent}>{user.email}</div>
              </div>
            </Flex>
          </Col>
          <Col className={styles.aiCol} span={6}>
            <Flex align="center" justify="center" vertical>
              <div>
                <div className={styles.aiItemIcon}>
                  <img src={`${IMG}/Frame_2037235606.png`} alt="" />
                </div>
                <div className={styles.aiItemTitle2}>网址</div>
                <div className={styles.aiItemContent}>{user.url ? <a href={user.url} target="_blank">{user.url}</a> : '-'}</div>
              </div>
            </Flex>
          </Col>
        </Row>
      )}
    </Card>
  );
}

// 各平台收录对比组件
function PlatformRatioChart({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [option, setOption] = useState({});

  useEffect(() => {
    if (!userId) {
      setOption({});
      return;
    }
    (async () => {
      const res = await api.get('/keywordsearchrank/platformRatio', { params: { userId } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        if (!data || data.length === 0) {
          setOption({});
          return;
        }
        const colors = ['#ffb3a7', '#ff9f91', '#ff8a7a', '#ff7563', '#ff6150', '#ff4c3c', '#ff3727', '#ff4c3c', '#ff7563'];
        const chartData = data.map((e: PlatformRatioItem, i: number) => ({
          id: i + 1,
          name: e.platform,
          count: e.count,
          color: colors[i % colors.length],
        }));
        setOption({
          tooltip: { trigger: 'item' },
          legend: {
            formatter: (name: string) => {
              const item = chartData.find((s: { name: string }) => s.name === name);
              return isMobile ? `{icon_${name}|} ${name}: ${item?.count}` : `${name}: ${item?.count}`;
            },
            ...(isMobile
              ? {
                  top: 'bottom',
                  itemWidth: 12,
                  itemHeight: 12,
                  itemGap: 8,
                  textStyle: {
                    fontSize: 11,
                    rich: Object.fromEntries(
                      chartData.map((e: { name: string }) => [
                        `icon_${e.name}`,
                        {
                          backgroundColor: { image: PLATFORM_ICONS[e.name] || '' },
                          width: 14,
                          height: 14,
                          borderRadius: 7,
                        },
                      ])
                    ),
                  },
                }
              : { orient: 'vertical', left: '50%', itemGap: 30, top: 'center' }),
          },
          series: [
            {
              name: '占比',
              type: 'pie',
              radius: ['45%', '70%'],
              label: { show: false },
              data: chartData.map((e: { count: number; name: string; color: string }) => ({
                value: e.count,
                name: e.name,
                itemStyle: { color: e.color },
              })),
              ...(isMobile ? { center: ['50%', '40%'] } : { center: ['25%', '50%'] }),
            },
            {
              type: 'pie',
              radius: ['0%', '35%'],
              silent: true,
              label: { show: false },
              itemStyle: { color: 'transparent' },
              data: [{ value: 1 }],
              ...(isMobile ? { center: ['50%', '40%'] } : { center: ['25%', '50%'] }),
            },
          ],
        });
      }
    })();
  }, [isMobile, userId]);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.prCardHeader} ${isMobile ? styles.prMobile : styles.prPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Graph.png`} alt="" />
          </div>
          <div className={styles.prTitle}>各平台收录占比</div>
        </div>
      }
      className={`${styles.gCard} ${styles.prWrapper} ${isMobile ? styles.prMobile : styles.prPc}`}
    >
      <ReactECharts option={option} style={{ height: isMobile ? 320 : 400, width: '100%' }} opts={{ renderer: 'canvas' }} />
    </Card>
  );
}

// 蒸馏关键词排名组件
function KeywordRankChart({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [list, setList] = useState<KeywordCountItem[]>([]);

  useEffect(() => {
    if (!userId) {
      setList([]);
      return;
    }
    (async () => {
      const res = await api.get('/keywordsearchrank/keywordcound', { params: { userId } });
      if (res.data?.code === 200) {
        setList(res.data.data || []);
      }
    })();
  }, [userId]);

  const maxCount = Math.max(...list.map((e) => e.count), 1);

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.krCardHeader} ${isMobile ? styles.krMobile : styles.krPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Activity.png`} alt="" />
          </div>
          <div className={styles.krTitle}>核心关键词排名</div>
        </div>
      }
      className={`${styles.gCard} ${styles.krWrapper} ${isMobile ? styles.krMobile : styles.krPc}`}
    >
      <div className={styles.krContentWrapper}>
        {list.map((e) => (
          <div key={e.distillateKeyword} className={styles.krItem}>
            <div className={styles.krName}>{e.distillateKeyword}</div>
            <div className={styles.krBarWrapper}>
              <div
                className={styles.krBar}
                style={{ width: `${Math.max((e.count / maxCount) * 100, 2)}%` }}
              />
            </div>
            <div className={styles.krCount}>{e.count}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// 关键词数量组件
function KeywordStats({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [stats, setStats] = useState<StatsData>({ count: 0, zlgjc: 0, ppgjc: 0, total: 0 });

  useEffect(() => {
    if (!userId) {
      setStats({ count: 0, zlgjc: 0, ppgjc: 0, total: 0 });
      return;
    }
    (async () => {
      const res = await api.get('/dstillateKeyword/countDstillateKeyword', { params: { userId } });
      if (res.data?.code === 200) {
        setStats(res.data.data);
      }
    })();
  }, [userId]);

  const items = [
    { icon: 'Iconly_Glass_Clock.png', title: '核心关键词', count: stats.count },
    { icon: 'Gallery.png', title: '蒸馏关键词', count: stats.zlgjc },
    { icon: 'Gallery (1).png', title: '品牌关键词', count: stats.ppgjc },
    { icon: 'Iconly_Glass_Document.png', title: '总收录条数', count: stats.total },
  ];

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.ksCardHeader} ${isMobile ? styles.ksMobile : styles.ksPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Discovery.png`} alt="" />
          </div>
          <div className={styles.ksTitle}>关键词数量</div>
        </div>
      }
      className={`${styles.gCard} ${styles.ksWrapper} ${isMobile ? styles.ksMobile : styles.ksPc}`}
    >
      {isMobile ? (
        <div className={styles.ksItemsWrapper}>
          {items.map((item) => (
            <div key={item.title} className={styles.ksItemWrapper}>
              <div className={styles.ksIcon}>
                <img src={`${IMG}/${encodeURIComponent(item.icon)}`} alt="" />
              </div>
              <div className={styles.ksContentWrapper}>
                <div className={styles.ksTitle2}>{item.title}</div>
                <div className={styles.ksCount}>{item.count}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Row className={styles.ksContentWrapper}>
          {items.map((item, idx) => (
            <Col key={item.title} span={6}>
              <div className={styles.ksItemWrapper}>
                <div className={styles.ksIcon}>
                  <img src={`${IMG}/${encodeURIComponent(item.icon)}`} alt="" />
                </div>
                <div className={styles.ksContentWrapper2}>
                  <div className={styles.ksTitle2}>{item.title}</div>
                  <div className={styles.ksCount}>{item.count}</div>
                </div>
                {idx < items.length - 1 && <div className={styles.ksSplitLine} />}
              </div>
            </Col>
          ))}
        </Row>
      )}
    </Card>
  );
}

// 搜索排名组件
function SearchRank({ isMobile, userId }: { isMobile: boolean; userId: string }) {
  const [searchType, setSearchType] = useState('keywords');
  const [platforms, setPlatforms] = useState<PlatformRatioItem[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformRatioItem | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState({ current: 1, pageSize: 10 });
  const [total, setTotal] = useState(0);
  const [keywordOptions, setKeywordOptions] = useState<KeywordCountItem[]>([]);
  const [list, setList] = useState<SearchRankItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async (type: string, pt?: string, kw?: string, pageNum = 1, pageSize = 10) => {
    if (!userId) {
      setList([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    try {
      const params: Record<string, string> = { type, pageNum: String(pageNum), pageSize: String(pageSize), userId };
      if (pt) params.pt = pt;
      if (kw) params.keyword = kw;
      const res = await api.get('/keywordsearchrank/keypage', { params });
      if (res.data?.code === 200) {
        setList(res.data.data?.list || []);
        setTotal(res.data.data?.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const init = useCallback(async () => {
    if (!userId) {
      setPlatforms([]);
      setActivePlatform(undefined);
      setKeywordOptions([]);
      setList([]);
      setTotal(0);
      return;
    }
    const params: Record<string, string> = { userId };
    const res = await api.get('/keywordsearchrank/platformRatio', { params });
    if (res.data?.code === 200) {
      setPlatforms(res.data.data || []);
      setActivePlatform(res.data.data?.[0]);
      fetchData(searchType, res.data.data?.[0]?.platform, keyword, 1, page.pageSize);
    }
    const res2 = await api.get('/keywordsearchrank/keywordcound', { params });
    if (res2.data?.code === 200) {
      setKeywordOptions([{ distillateKeyword: '', count: 0 }, ...(res2.data.data || [])]);
    }
  }, [userId, fetchData, searchType, keyword, page.pageSize]);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleSearchTypeChange = (v: string) => {
    setSearchType(v);
    setPage({ current: 1, pageSize: page.pageSize });
    fetchData(v, activePlatform?.platform, keyword, 1, page.pageSize);
  };

  const handlePlatformChange = (p: PlatformRatioItem) => {
    setActivePlatform(p);
    setPage({ current: 1, pageSize: page.pageSize });
    fetchData(searchType, p.platform, keyword, 1, page.pageSize);
  };

  const handleKeywordChange = (k: string) => {
    setKeyword(k);
    setPage({ current: 1, pageSize: page.pageSize });
    fetchData(searchType, activePlatform?.platform, k, 1, page.pageSize);
  };

  const handlePageChange = (current: number, pageSize: number) => {
    setPage({ current, pageSize });
    fetchData(searchType, activePlatform?.platform, keyword, current, pageSize);
  };

  const columns = [
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', key: 'distillateKeyword' },
    { title: '核心关键词', dataIndex: 'expandedKeyword', key: 'expandedKeyword' },
    { title: '平台', align: 'center' as const, dataIndex: 'platform', key: 'platform' },
    {
      title: '查询时间',
      align: 'center' as const,
      dataIndex: 'queryTime',
      key: 'queryTime',
      render: (e: string) => (e ? e.split(' ')[0] : e),
    },
    {
      title: '查看详情',
      align: 'center' as const,
      key: 'zlgjcUrl',
      dataIndex: 'zlgjcUrl',
      render: (e: string) =>
        e ? (
          <a href={e} target="_blank" rel="noopener noreferrer" className={styles.srDetailLink}>
            跳 转
          </a>
        ) : null,
    },
  ];

  const mobileColumns = [
    { title: '核心关键词', dataIndex: 'expandedKeyword', key: 'expandedKeyword', width: 90 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', key: 'distillateKeyword', width: 100 },
    { title: '平台', align: 'center' as const, dataIndex: 'platform', key: 'platform', width: 70 },
    {
      title: '查询时间',
      align: 'center' as const,
      dataIndex: 'queryTime',
      key: 'queryTime',
      width: 70,
      render: (e: string) => (e ? e.split(' ')[0] : e),
    },
    {
      title: '查看详情',
      align: 'center' as const,
      key: 'zlgjcUrl',
      dataIndex: 'zlgjcUrl',
      width: 70,
      render: (e: string) =>
        e ? (
          <a href={e} target="_blank" rel="noopener noreferrer" className={styles.srDetailLink}>
            跳转
          </a>
        ) : null,
    },
  ];

  return (
    <Card
      title={
        <div className={`${styles.gCardHeader} ${styles.srCardHeader} ${isMobile ? styles.srMobile : styles.srPc}`}>
          <div className={styles.gIcon}>
            <img src={`${IMG}/Iconly_Glass_Chart.png`} alt="" />
          </div>
          <div className={styles.srTitle}>搜索排名</div>
        </div>
      }
      className={`${styles.gCard} ${styles.srWrapper} ${isMobile ? styles.srMobile : styles.srPc}`}
    >
      <div className={styles.srBtnsWrapper}>
        <div className={styles.srBtns}>
          <Radio.Group
            value={searchType}
            onChange={(e) => handleSearchTypeChange(e.target.value)}
            buttonStyle="solid"
            className={styles.srBtnWrapper}
          >
            <Radio.Button value="keywords" className={styles.srBtn}>关键词搜索</Radio.Button>
            <Radio.Button value="brand" className={styles.srBtn}>品牌搜索</Radio.Button>
            <Radio.Button value="scene" className={styles.srBtn}>联系方式</Radio.Button>
          </Radio.Group>
        </div>
      </div>
      <div className={styles.srTabsWrapper}>
        <div className={styles.srTabs}>
          {platforms.map((e) => (
            <Tag.CheckableTag
              key={e.platform}
              checked={activePlatform?.platform === e.platform}
              className={`${styles.srTab} ${activePlatform?.platform === e.platform ? styles.srChecked : ''}`}
              onClick={() => handlePlatformChange(e)}
            >
              <div className={styles.srPlatformItem}>
                <span>{e.platform}</span>
                <span>({e.count})</span>
              </div>
            </Tag.CheckableTag>
          ))}
        </div>
        {isMobile ? (
          <div className={styles.srSelectWrapper}>
            <Select
              value={keyword}
              popupMatchSelectWidth={false}
              onChange={handleKeywordChange}
              options={keywordOptions.map((e) => ({
                value: e.distillateKeyword,
                label: e.distillateKeyword === '' ? '全部' : `${e.distillateKeyword}(${e.count})`,
              }))}
            />
          </div>
        ) : (
          <div className={styles.srSelectWrapper}>
            <Select
              value={keyword}
              style={{ width: 120 }}
              popupMatchSelectWidth={false}
              onChange={handleKeywordChange}
              options={keywordOptions.map((e) => ({
                value: e.distillateKeyword,
                label: e.distillateKeyword === '' ? '全部' : `${e.distillateKeyword}(${e.count})`,
              }))}
            />
          </div>
        )}
      </div>
      <div className={styles.srList}>
        {isMobile ? (
          <div className={styles.srTableWrapperMobile}>
            <Table
              columns={mobileColumns}
              className={`${styles.srTable} ${styles.srMobileTable}`}
              dataSource={list}
              pagination={false}
              loading={loading}
              rowKey="id"
              size="small"
              scroll={{ x: 400 }}
            />
          </div>
        ) : (
          <div className={styles.srTableWrapper}>
            <Table
              columns={columns}
              className={styles.srTable}
              dataSource={list}
              pagination={false}
              loading={loading}
              rowKey="id"
              size="small"
            />
          </div>
        )}
        <div className={styles.srPageWrapper}>
          <Pagination
            current={page.current}
            pageSize={page.pageSize}
            total={total}
            align="center"
            showSizeChanger={false}
            size={isMobile ? 'small' : undefined}
            onChange={handlePageChange}
          />
        </div>
      </div>
    </Card>
  );
}

// 主页面
export default function DashboardPage() {
  const router = useRouter();
  // 响应式：参考 7asi.com 的手机端效果，小视口下使用单列垂直布局
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<LoginUser>({ id: '-1', username: '', phone: '', url: '', email: '', password: '', address: '', level: '', cid: '', dateTime: '' });
  const [lastUpdate, setLastUpdate] = useState('');
  const [currentTime, setCurrentTime] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  // 是否为管理员（只有管理员才能切换用户）
  const [isAdmin, setIsAdmin] = useState(false);
  // 分享功能相关状态
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareTokens, setShareTokens] = useState<Array<{ token: string; createTime: string; lastUseTime: string | null }>>([]);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await api.get('/users/getLoginUser');
        if (res.data?.code === 200) {
          const userData = res.data.data;
          setLastUpdate(userData.dateTime || '');
          setUser(userData);
          // 判断是否为管理员（level === '1'）
          const admin = userData.level === '1';
          setIsAdmin(admin);
          if (admin) {
            // 管理员：获取用户列表，默认选择第一个非 admin 用户
            try {
              const usersRes = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
              if (usersRes.data?.code === 200) {
                const allUsers = usersRes.data.data?.list || [];
                const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
                setUsers(userList);
                if (userList.length > 0) {
                  setSelectedUserId(String(userList[0].id));
                }
              }
            } catch {
              // 忽略错误
            }
          } else {
            // 普通用户：只能看自己的数据
            setSelectedUserId(String(userData.id));
          }
        } else if (res.data?.code === 401) {
          // 未登录，跳转到登录页
          router.push('/login');
        }
      } catch {
        // 忽略错误
      }
    };
    fetchUser();

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    setCurrentTime(`${y}年${m}月${d}日`);

    setTimeout(() => setLoading(false), 1000);
  }, [router]);

  // 切换用户时更新最后更新时间
  useEffect(() => {
    if (!selectedUserId) return;
    (async () => {
      try {
        const res = await api.get('/users/getLoginUser', { params: { userId: selectedUserId } });
        if (res.data?.code === 200) {
          setLastUpdate(res.data.data.dateTime || '');
        }
      } catch {
        // 忽略错误
      }
    })();
  }, [selectedUserId]);

  // 切换用户时更新header显示的用户名
  const displayUsername = selectedUserId
    ? users.find((u) => u.id === selectedUserId)?.username || user.username
    : user.username;

  const onLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userInfo');
    localStorage.removeItem('shareLogin');
    router.push('/login');
  };

  // 生成分享链接
  const onGenerateShare = async () => {
    setShareLoading(true);
    try {
      // 管理员可为指定用户生成，普通用户为自己生成
      const body: Record<string, any> = {};
      if (isAdmin && selectedUserId) {
        body.userId = selectedUserId;
      }
      const res = await api.post('/users/generateShareToken', body);
      if (res.data?.code === 200 && res.data.data?.shareToken) {
        const url = `${window.location.origin}/share/${res.data.data.shareToken}`;
        setShareUrl(url);
        message.success('分享链接生成成功');
        // 刷新分享链接列表
        loadShareTokens();
      } else {
        message.error(res.data?.message || '生成失败');
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '生成失败');
    } finally {
      setShareLoading(false);
    }
  };

  // 加载已有分享链接列表
  const loadShareTokens = async () => {
    try {
      const params: Record<string, string> = {};
      if (isAdmin && selectedUserId) {
        params.userId = selectedUserId;
      }
      const res = await api.get('/users/shareTokens', { params });
      if (res.data?.code === 200) {
        setShareTokens(res.data.data || []);
      }
    } catch {
      // 忽略
    }
  };

  // 删除分享链接
  const onDeleteShareToken = async (token: string) => {
    try {
      const res = await api.post('/users/deleteShareToken', { token });
      if (res.data?.code === 200) {
        message.success('删除成功');
        loadShareTokens();
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch {
      message.error('删除失败');
    }
  };

  // 复制到剪贴板
  const onCopyShareUrl = () => {
    if (!shareUrl) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        message.success('已复制到剪贴板');
      }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        message.success('已复制到剪贴板');
      });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      message.success('已复制到剪贴板');
    }
  };

  // 打开分享弹窗
  const onOpenShareModal = () => {
    setShareModalVisible(true);
    setShareUrl('');
    loadShareTokens();
  };

  return (
    <div className={`${styles.wrapper} ${isMobile ? styles.mobile : styles.pc}`}>
      {loading && (
        <div className={styles.gLoading}>
          <Spin tip="巨量引力GEO" size="large">
            <div style={{ width: '280px' }}>1</div>
          </Spin>
        </div>
      )}

      {/* 退出登录 + 分享按钮（仅PC端显示） */}
      {!isMobile && (
        <div className={styles.logoutWrapper}>
          <Button onClick={onOpenShareModal} size="small" type="primary" style={{ marginRight: 8 }}>
            分享报告
          </Button>
          <Button onClick={onLogout} size="small">退出登录</Button>
        </div>
      )}

      {/* Header */}
      {isMobile ? (
        <div className={styles.header}>
          <div className={styles.headerBanner}>{displayUsername}</div>
          <div className={styles.headerUpdate}>最后更新:{lastUpdate}</div>
        </div>
      ) : (
        <div className={styles.header}>
          <Row gutter={16} className={styles.headerContent}>
            <Col span={8}>
              <div className={styles.lastTime}>最后更新时间：{lastUpdate}</div>
            </Col>
            <Col span={8}>
              <div className={styles.headerName}>{displayUsername}</div>
            </Col>
            <Col span={8}>
              <div className={styles.currentTime}>{currentTime}</div>
            </Col>
          </Row>
        </div>
      )}

      {/* 用户切换（仅管理员可见）*/}
      {isAdmin && (
        <div className={styles.userSwitchWrapper}>
          <span className={styles.userSwitchLabel}>切换用户：</span>
          <Select
            value={selectedUserId || undefined}
            placeholder="切换"
            onChange={(val) => setSelectedUserId(val ? String(val) : '')}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: isMobile ? 140 : 100 }}
            options={users.map((u) => ({ value: String(u.id), label: u.username }))}
          />
        </div>
      )}

      {/* Content */}
      <div className={styles.contentWrapper}>
        {!isMobile ? (
          <div className={styles.pc}>
            <Row className={styles.leftWrapper} gutter={24}>
              <Col span={10} className={styles.leftCol}>
                <div className={styles.baseInfo}><AICard isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info1}><PlatformRatioChart isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info2}><KeywordRankChart isMobile={false} userId={selectedUserId} /></div>
              </Col>
              <Col span={13} className={styles.rightCol}>
                <div className={styles.info3}><KeywordStats isMobile={false} userId={selectedUserId} /></div>
                <div className={styles.info4}><SearchRank isMobile={false} userId={selectedUserId} /></div>
              </Col>
            </Row>
          </div>
        ) : (
          <div className={styles.mobile}>
            <div className={styles.baseInfo}><AICard isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info3}><KeywordStats isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info1}><PlatformRatioChart isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info2}><KeywordRankChart isMobile={true} userId={selectedUserId} /></div>
            <div className={styles.info4}><SearchRank isMobile={true} userId={selectedUserId} /></div>
          </div>
        )}
      </div>
      <div className={styles.footerWrapper} />

      {/* 底部特别声明 */}
      <div className={styles.disclaimer}>
        特别声明：由于各大模型的搜索结果因人而异，报表检测数据请以系统当前的实际检测结果为准。若出现轻微波动属于正常情况，建议可更换不同设备进行多次检索以获得更稳定的参考。
      </div>

      {/* 分享报告弹窗 */}
      <Modal
        title="分享GEO报告"
        open={shareModalVisible}
        onCancel={() => setShareModalVisible(false)}
        footer={null}
        width={isMobile ? '90%' : 560}
      >
        <div style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            onClick={onGenerateShare}
            loading={shareLoading}
            block
          >
            生成新的分享链接
          </Button>
          <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
            分享链接有效期为365天，打开后自动登录并显示当前{isAdmin ? '选中用户' : '用户'}的GEO报告。
          </div>
        </div>

        {shareUrl && (
          <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 4 }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>最新分享链接：</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={shareUrl}
                readOnly
                style={{
                  flex: 1, padding: '6px 8px', border: '1px solid #d9d9d9',
                  borderRadius: 4, fontSize: 12, color: '#333'
                }}
              />
              <Button type="primary" size="small" onClick={onCopyShareUrl}>
                复制
              </Button>
            </div>
          </div>
        )}

        {shareTokens.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8, borderTop: '1px solid #eee', paddingTop: 12 }}>
              历史分享链接：
            </div>
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {shareTokens.map((item) => (
                <div key={item.token} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 12
                }}>
                  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
                    {window.location.origin}/share/{item.token.substring(0, 16)}...
                  </div>
                  <div style={{ color: '#999', marginRight: 8, fontSize: 11 }}>
                    {item.lastUseTime ? `最近使用: ${new Date(item.lastUseTime).toLocaleDateString()}` : `创建: ${new Date(item.createTime).toLocaleDateString()}`}
                  </div>
                  <Button
                    size="small"
                    danger
                    onClick={() => onDeleteShareToken(item.token)}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
