import {
  AppstoreAddOutlined,
  DeleteOutlined,
  HistoryOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  InputNumber,
  Layout,
  List,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import type { SelectProps } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import ProfileModal, { ProfileFormValues } from "./components/ProfileModal";
import TerminalPanel, { TerminalMode, TerminalStatus } from "./components/TerminalPanel";
import { GitChanges, LogResponse, Profile, SessionSummary, SessionStatus, api } from "./api";

const { Header, Content, Sider } = Layout;
const { Paragraph, Text } = Typography;

const terminalStatusMap: Record<TerminalStatus, { color: string; label: string }> = {
  idle: { color: "default", label: "未连接" },
  connecting: { color: "geekblue", label: "连接中" },
  connected: { color: "green", label: "已连接" },
  closed: { color: "default", label: "已关闭" },
  error: { color: "red", label: "异常" },
};

const lifecycleLabels: Record<SessionStatus, { color: string; label: string }> = {
  running: { color: "green", label: "运行中" },
  completed: { color: "blue", label: "完成" },
  stopped: { color: "orange", label: "已停止" },
  error: { color: "red", label: "出错" },
  interrupted: { color: "magenta", label: "中断" },
};

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  return new Date(value).toLocaleString();
};

const App = () => {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [creatingSessions, setCreatingSessions] = useState(false);
  const [sessionProfileId, setSessionProfileId] = useState<number>();
  const [sessionQuantity, setSessionQuantity] = useState(1);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>("idle");
  const [gitInfo, setGitInfo] = useState<GitChanges | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [logState, setLogState] = useState<LogResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState<"all" | "active">("all");
  const statusHistoryRef = useRef<Record<string, SessionStatus>>({});

  useEffect(() => {
    void loadProfiles();
  }, []);

  useEffect(() => {
    void loadSessions();
  }, []);

  useEffect(() => {
    if (!sessions.length) {
      setSelectedSessionId(undefined);
      setGitInfo(null);
      setLogState(null);
      return;
    }
    if (selectedSessionId && sessions.some((item) => item.session_id === selectedSessionId)) {
      return;
    }
    setSelectedSessionId(sessions[0].session_id);
  }, [sessions, selectedSessionId]);

  useEffect(() => {
    const current = sessions.find((item) => item.session_id === selectedSessionId);
    if (!current) {
      setGitInfo(null);
      setLogState(null);
      return;
    }
    setGitInfo(null);
    if (current.status === "running") {
      setLogState(null);
    } else {
      void fetchLog(current.session_id);
    }
  }, [selectedSessionId, sessions]);

  const loadProfiles = async () => {
    try {
      setProfilesLoading(true);
      const data = await api.fetchProfiles();
      setProfiles(data);
      if (!sessionProfileId && data.length) {
        setSessionProfileId(data[0].id);
      }
    } catch (error) {
      message.error("加载配置失败，请检查后端服务");
    } finally {
      setProfilesLoading(false);
    }
  };

  const loadSessions = async (showToast = true, skipLoading = false) => {
    try {
      if (!skipLoading) {
        setSessionsLoading(true);
      }
      const data = await api.listSessions();
      notifyStatusTransitions(data, showToast);
      setSessions(data);
    } catch (error) {
      message.error("加载会话列表失败");
    } finally {
      if (!skipLoading) {
        setSessionsLoading(false);
      }
    }
  };

  const notifyStatusTransitions = (items: SessionSummary[], showToast: boolean) => {
    const map: Record<string, SessionStatus> = {};
    items.forEach((item) => {
      const prev = statusHistoryRef.current[item.session_id];
      if (showToast && prev === "running" && item.status !== "running") {
        const label = lifecycleLabels[item.status]?.label || item.status;
        message.success(`会话 ${item.session_id.slice(0, 6)} ${label}`);
      }
      map[item.session_id] = item.status;
    });
    statusHistoryRef.current = map;
  };

  const handleProfileSubmit = async (values: ProfileFormValues) => {
    try {
      const created = await api.createProfile(values);
      message.success("配置创建成功");
      setProfiles((prev) => [...prev, created]);
      setSessionProfileId(created.id);
    } catch (error) {
      message.error("创建配置失败");
      throw error;
    }
  };

  const handleDeleteProfile = async (id: number) => {
    try {
      await api.deleteProfile(id);
      setProfiles((prev) => prev.filter((item) => item.id !== id));
      message.success("配置已删除");
      if (sessionProfileId === id) {
        setSessionProfileId(undefined);
      }
    } catch (error) {
      message.error("无法删除配置");
    }
  };

  const handleCreateSessions = async () => {
    if (!sessionProfileId) {
      message.warning("请先选择启动配置");
      return;
    }
    try {
      setCreatingSessions(true);
      const created = await api.createSession(sessionProfileId, sessionQuantity);
      const ids = created.map((item) => item.session_id.slice(0, 6)).join(", ");
      message.success(`已创建 ${created.length} 个会话 (${ids})`);
      await loadSessions(false, true);
      setSelectedSessionId(created[0].session_id);
    } catch (error) {
      message.error("创建会话失败");
    } finally {
      setCreatingSessions(false);
    }
  };

  const fetchGit = async (sessionId: string) => {
    try {
      setGitLoading(true);
      const data = await api.fetchGitChanges(sessionId);
      setGitInfo(data);
      if (!data.git && data.message) {
        message.info(data.message);
      }
    } catch (error) {
      message.error("获取 Git 状态失败");
    } finally {
      setGitLoading(false);
    }
  };

  const fetchLog = async (sessionId: string) => {
    try {
      setLogLoading(true);
      const data = await api.fetchLogs(sessionId);
      setLogState(data);
    } catch (error) {
      message.error("读取日志失败");
    } finally {
      setLogLoading(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      setDeletingSessionId(sessionId);
      await api.deleteSession(sessionId);
      message.success(`会话 ${sessionId.slice(0, 6)} 已删除`);
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(undefined);
        setGitInfo(null);
        setLogState(null);
      }
      await loadSessions(false, true);
    } catch (error) {
      message.error("删除会话失败");
    } finally {
      setDeletingSessionId(null);
    }
  };

  const selectedSession = useMemo(
    () => sessions.find((item) => item.session_id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const filteredSessions = useMemo(() => {
    if (historyMode === "active") {
      return sessions.filter((item) => item.status === "running");
    }
    return sessions;
  }, [sessions, historyMode]);

  const profileOptions = useMemo<SelectProps["options"]>(
    () => profiles.map((item) => ({ value: item.id, label: item.name })),
    [profiles],
  );

  const terminalMode: TerminalMode = selectedSession
    ? selectedSession.status === "running"
      ? "live"
      : "replay"
    : "idle";

  useEffect(() => {
    if (terminalMode === "live") {
      setTerminalStatus("connecting");
    } else if (terminalMode === "replay") {
      setTerminalStatus("closed");
    } else {
      setTerminalStatus("idle");
    }
  }, [terminalMode]);

  const terminalNote =
    terminalMode === "idle"
      ? "请选择一个会话以查看终端输出。"
      : terminalMode === "replay"
        ? logState?.message || "以下内容来自历史日志。"
        : undefined;

  const terminalLog = terminalMode === "replay" ? logState?.content : undefined;

  const gitBlock = () => {
    if (!selectedSession) {
      return <Empty description="请选择会话查看 Git 信息" />;
    }
    if (gitLoading) {
      return (
        <div className="git-loading">
          <Spin />
        </div>
      );
    }
    if (!gitInfo) {
      return <Empty description="暂无数据" />;
    }
    if (!gitInfo.git) {
      return <Alert type="info" showIcon message={gitInfo.message || "当前目录不是 Git 仓库"} />;
    }
    return (
      <>
        <List
          size="small"
          dataSource={gitInfo.status || []}
          locale={{ emptyText: "工作树干净" }}
          renderItem={(item) => (
            <List.Item>
              <Space>
                <Tag color="blue">{item.status}</Tag>
                <Text>{item.path}</Text>
              </Space>
            </List.Item>
          )}
        />
        {gitInfo.diff_stat && (
          <Paragraph style={{ whiteSpace: "pre-wrap" }} copyable>
            {gitInfo.diff_stat}
          </Paragraph>
        )}
      </>
    );
  };

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand">
          <Text className="brand-title">Codex Terminal Manager</Text>
          <Badge color={terminalStatusMap[terminalStatus].color as any} text={terminalStatusMap[terminalStatus].label} />
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void loadSessions()}>
            刷新会话
          </Button>
          <Button type="primary" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
            设定
          </Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={420} className="session-sider">
          <Card
            title="历史会话记录"
            className="session-card history-card"
            extra={
              <Space>
                <Segmented
                  value={historyMode}
                  options={[
                    { label: "全部", value: "all" },
                    { label: "运行中", value: "active" },
                  ]}
                  onChange={(value) => setHistoryMode(value as "all" | "active")}
                />
                <Button icon={<ReloadOutlined />} onClick={() => void loadSessions()}>
                  刷新
                </Button>
              </Space>
            }
            size="small"
          >
            <div className="history-list">
              <Spin spinning={sessionsLoading}>
                <List
                  dataSource={filteredSessions}
                  rowKey={(item) => item.session_id}
                  locale={{ emptyText: historyMode === "active" ? "暂无运行中的终端" : "暂无会话" }}
                  renderItem={(item) => {
                    const meta = lifecycleLabels[item.status];
                    const isActive = item.session_id === selectedSessionId;
                    return (
                      <List.Item
                        className={isActive ? "session-item active" : "session-item"}
                        onClick={() => setSelectedSessionId(item.session_id)}
                        actions={[
                          <Popconfirm
                            title="删除此会话及日志？"
                            okText="删除"
                            cancelText="取消"
                            onConfirm={() => void handleDeleteSession(item.session_id)}
                            okButtonProps={{ loading: deletingSessionId === item.session_id }}
                            key="delete-session"
                          >
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={(event) => event.stopPropagation()}
                            />
                          </Popconfirm>,
                        ]}
                      >
                        <div className="session-item-body">
                          <Space direction="vertical" size={2}>
                            <Space align="center">
                              <Text strong>{item.profile.name}</Text>
                              <Tag color={meta.color}>{meta.label}</Tag>
                            </Space>
                            <Text type="secondary" className="session-meta">
                              {item.session_id.slice(0, 8)} · {formatDate(item.created_at)}
                            </Text>
                          </Space>
                          {item.exit_code !== null && item.exit_code !== undefined && (
                            <Tag color={item.exit_code === 0 ? "green" : "red"}>退出码 {item.exit_code}</Tag>
                          )}
                        </div>
                      </List.Item>
                    );
                  }}
                />
              </Spin>
            </div>
          </Card>
          <Card title="启动新会话" className="session-card" size="small">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Select
                placeholder="选择启动配置"
                options={profileOptions}
                value={sessionProfileId}
                loading={profilesLoading}
                onChange={(value) => setSessionProfileId(value)}
                allowClear
              />
              <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
                <Text type="secondary">数量</Text>
                <InputNumber
                  min={1}
                  max={10}
                  value={sessionQuantity}
                  onChange={(value) => setSessionQuantity(Number(value) || 1)}
                />
              </Space>
              <Button
                type="primary"
                block
                icon={<AppstoreAddOutlined />}
                loading={creatingSessions}
                onClick={() => void handleCreateSessions()}
              >
                启动终端
              </Button>
            </Space>
          </Card>
        </Sider>
        <Content className="session-content">
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card
              title={selectedSession ? `会话 ${selectedSession.session_id.slice(0, 8)}` : "终端输出"}
              extra={
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={() => selectedSession && fetchLog(selectedSession.session_id)}>
                    刷新日志
                  </Button>
                  <Button
                    icon={<HistoryOutlined />}
                    onClick={() => selectedSession && fetchGit(selectedSession.session_id)}
                    loading={gitLoading}
                  >
                    刷新 Git
                  </Button>
                </Space>
              }
            >
              {terminalMode === "replay" && logLoading ? (
                <div className="terminal-loading">
                  <Spin tip="加载历史日志..." />
                </div>
              ) : (
                <TerminalPanel
                  sessionId={terminalMode === "live" ? selectedSession?.session_id : undefined}
                  sessionIds={sessions.map((item) => item.session_id)}
                  mode={terminalMode}
                  note={terminalNote}
                  logContent={terminalLog}
                  onStatusChange={setTerminalStatus}
                />
              )}
            </Card>
            <Card title="会话详情" size="small">
              {selectedSession ? (
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="配置">{selectedSession.profile.name}</Descriptions.Item>
                  <Descriptions.Item label="状态">
                    <Tag color={lifecycleLabels[selectedSession.status].color}>
                      {lifecycleLabels[selectedSession.status].label}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="命令" span={2}>
                    {selectedSession.profile.command} {selectedSession.profile.args.join(" ")}
                  </Descriptions.Item>
                  <Descriptions.Item label="工作目录" span={2}>
                    {selectedSession.cwd || "默认目录"}
                  </Descriptions.Item>
                  <Descriptions.Item label="创建时间">{formatDate(selectedSession.created_at)}</Descriptions.Item>
                  <Descriptions.Item label="结束时间">{formatDate(selectedSession.finished_at)}</Descriptions.Item>
                  <Descriptions.Item label="日志位置" span={2}>
                    <Text type="secondary">{selectedSession.log_path}</Text>
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Empty description="请选择会话" />
              )}
            </Card>
            <Card title="Git 状态" size="small">
              {gitBlock()}
            </Card>
          </Space>
        </Content>
      </Layout>
      <Drawer
        title="会话设定"
        placement="right"
        width={420}
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Button type="primary" icon={<AppstoreAddOutlined />} onClick={() => setProfileModalOpen(true)} block>
            新建启动配置
          </Button>
          <List
            header={`全部配置 (${profiles.length})`}
            dataSource={profiles}
            loading={profilesLoading}
            locale={{ emptyText: "暂无配置" }}
            rowKey="id"
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Popconfirm
                    title="确认删除该配置？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void handleDeleteProfile(item.id)}
                    key="delete"
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={item.name}
                  description={
                    <div>
                      <Text>
                        {item.command} {item.args.join(" ")}
                      </Text>
                      <br />
                      <Text type="secondary">{item.cwd || "默认目录"}</Text>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        </Space>
      </Drawer>
      <ProfileModal open={profileModalOpen} onCancel={() => setProfileModalOpen(false)} onSubmit={handleProfileSubmit} />
    </Layout>
  );
};

export default App;
