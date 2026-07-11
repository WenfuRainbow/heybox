/** 用户等级信息 */
export interface LevelInfo {
    level: number;
    /** status === 1 表示等级有效 */
    status: number;
}

/** 用户勋章 */
export interface Medal {
    medal_id: number;
    name: string;
    description: string;
    img_url: string;
    level: number;
    /** 是否已获得 */
    achieved: number;
    /** 是否佩戴中 */
    wear: number;
}

/** 用户信息（发帖人 / 评论者通用） */
export interface User {
    userid: number;
    username: string;
    avatar: string;
    level_info: LevelInfo;
    medals: Medal[];
}

/** 话题/板块标签 */
export interface Topic {
    topic_id: number;
    name: string;
    pic_url?: string;
}

/** 帖子中的图片信息 */
export interface PostImage {
    url: string;
    width?: number;
    height?: number;
}

/**
 * 帖子核心数据结构
 * 包含标题、正文、作者、互动数据（点赞/收藏/评论数）等
 */
export interface PostLink {
    linkid: number;
    title: string;
    /** 帖子摘要/描述 */
    description: string;
    /** 帖子正文，可能是纯文本或 JSON 格式的富文本块 */
    text: string;
    user: User;
    topics: Topic[];
    up: number;
    down: number;
    favour_count: number;
    comment_num: number;
    create_at: number;
    modify_at: number;
    ip_location: string;
    content_type: number;
    link_type: number;
    link_tag: number;
    share_url: string;
    pics?: PostImage[];
    has_video?: number;
}

/** 评论者类型别名（与 User 相同结构） */
export type CommentUser = User;

/** 评论中的图片 */
export interface CommentImage {
    url: string;
    thumb: string;
    width: number;
    height: number;
}

/** 单条评论数据 */
export interface Comment {
    commentid: string;
    text: string;
    up: number;
    down: number;
    /** 楼层号 */
    floor_num: number;
    create_at: number;
    ip_location: string;
    user: CommentUser;
    /** 被回复的用户，null 表示顶级评论 */
    replyuser: CommentUser | null;
    imgs: CommentImage[];
}

/** 评论组：一条主评论及其子回复 */
export interface CommentGroup {
    comment: Comment[];
}

/**
 * 帖子详情接口返回值
 * 包含帖子本体和按组组织的评论列表
 */
export interface PostTreeResult {
    link: PostLink;
    comments: CommentGroup[];
    /** 是否还有更多楼层（分页标识） */
    has_more_floors: number;
}

/** API 通用响应包装 */
export interface ApiResponse<T> {
    status: string;
    msg: string;
    result: T;
}

/**
 * 搜索结果中的单条帖子信息（精简版，不含正文）
 * 用于列表展示和收藏夹存储
 */
export interface SearchItemInfo {
    linkid: number;
    userid: number;
    title: string;
    description: string;
    link_type: number;
    link_tag: number;
    is_web: number;
    comment_num: number;
    create_at: number;
    modify_at: number;
    share_url: string;
    up: number;
    down: number;
    topics: Topic[];
    has_video: number;
}

/** 搜索结果条目包装 */
export interface SearchItem {
    info: SearchItemInfo;
}

/** 搜索接口返回值 */
export interface SearchResult {
    items: SearchItem[];
    bottom_tips: string;
}

/**
 * 板块子项数据
 * 代表一个板块/话题分类，可包含热度信息和关联游戏
 */
export interface TopicChild {
    name: string;
    topic_id: number;
    small_pic_url?: string;
    hot?: { raw_hot_value: number; desc: string; level: number };
    valid: number;
    game?: { app_id: number };
}

/** 板块分类列表接口返回值 */
export interface TopicCategoryResult {
    follow_topic_limit: number;
    recommend_for_user_topics: { name: string; key: string; children: TopicChild[] };
    latest_hot_topics: { name: string; children: TopicChild[] };
}

/** 消息通知中的用户信息 */
export interface MessageUser {
    heybox_id: string;
    username: string;
    nickname: string;
    avatar: string;
    level_info?: { level: number };
}

/** 消息关联的帖子链接 */
export interface MessageLink {
    linkid: string;
    title: string;
}

/** 单条消息通知 */
export interface MessageItem {
    message_id: string;
    message_type: string;
    text: string;
    create_at: number;
    user_a: MessageUser;
    link?: MessageLink;
    link_id?: string;
    linkid?: string;
    link_title?: string;
    /** 被引用的评论内容 */
    comment_a_text?: string;
}

/** 消息列表接口返回值 */
export interface MessageListResult {
    messages: MessageItem[];
}
