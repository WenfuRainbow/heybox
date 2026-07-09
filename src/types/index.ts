export interface LevelInfo {
    level: number;
    status: number;
}

export interface Medal {
    medal_id: number;
    name: string;
    description: string;
    img_url: string;
    level: number;
    achieved: number;
    wear: number;
}

export interface User {
    userid: number;
    username: string;
    avatar: string;
    level_info: LevelInfo;
    medals: Medal[];
}

export interface Topic {
    topic_id: number;
    name: string;
    pic_url?: string;
}

export interface PostImage {
    url: string;
    width?: number;
    height?: number;
}

export interface PostLink {
    linkid: number;
    title: string;
    description: string;
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

export type CommentUser = User;

export interface CommentImage {
    url: string;
    thumb: string;
    width: number;
    height: number;
}

export interface Comment {
    commentid: string;
    text: string;
    up: number;
    down: number;
    floor_num: number;
    create_at: number;
    ip_location: string;
    user: CommentUser;
    replyuser: CommentUser | null;
    imgs: CommentImage[];
}

export interface CommentGroup {
    comment: Comment[];
}

export interface PostTreeResult {
    link: PostLink;
    comments: CommentGroup[];
    has_more_floors: number;
}

export interface ApiResponse<T> {
    status: string;
    msg: string;
    result: T;
}

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

export interface SearchItem {
    info: SearchItemInfo;
}

export interface SearchResult {
    items: SearchItem[];
    bottom_tips: string;
}

export interface TopicChild {
    name: string;
    topic_id: number;
    small_pic_url?: string;
    hot?: { raw_hot_value: number; desc: string; level: number };
    valid: number;
    game?: { app_id: number };
}

export interface TopicCategoryResult {
    follow_topic_limit: number;
    recommend_for_user_topics: { name: string; key: string; children: TopicChild[] };
    latest_hot_topics: { name: string; children: TopicChild[] };
}

export interface SignTaskAward {
    desc: string;
    icon: string;
}

export interface SignTaskReportExtra {
    task_id: string;
    task_type: string;
}

export interface SignTaskItem {
    title: string;
    state: string;
    state_desc: string;
    type: string;
    report_extra?: SignTaskReportExtra;
    award_desc_v2?: SignTaskAward[];
}

export interface SignTaskGroup {
    title: string;
    tasks: SignTaskItem[];
}

export interface SignTaskListResult {
    user: { username: string; level_info: { coin: string } };
    task_list: SignTaskGroup[];
}

export interface SignV3StateResult {
    state: string;
    sign_in_coin?: number;
    sign_in_exp?: number;
    sign_in_streak?: number;
}

export interface MessageUser {
    heybox_id: string;
    username: string;
    nickname: string;
    avatar: string;
    level_info?: { level: number };
}

export interface MessageLink {
    linkid: string;
    title: string;
}

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
    comment_a_text?: string;
}

export interface MessageListResult {
    messages: MessageItem[];
}
