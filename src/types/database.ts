/**
 * Hand-maintained against the Step 2 migration; not generated from a remote DB.
 * Replace with official Supabase type generation after verified deployment.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type Table<
  Row,
  Required extends keyof Row,
  Generated extends keyof Row = never,
> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required | Generated>>;
  Update: Partial<Omit<Row, Generated>>;
  // Relationship joins are intentionally not exposed by these initial types.
  Relationships: [];
};

type Session = {
  id: string;
  session_code: string;
  status: "waiting" | "active" | "terminated";
  created_at: string;
  last_activity_at: string;
  activated_at: string | null;
  terminated_at: string | null;
  both_disconnected_at: string | null;
  inactivity_deadline_at: string | null;
  latest_question_id: string | null;
};

type Participant = {
  id: string;
  session_id: string;
  role: "sender" | "viewer";
  connection_status: "connected" | "disconnected";
  created_at: string;
  last_seen_at: string;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  explicitly_quit: boolean;
  quit_at: string | null;
  reconnect_token_hash: string;
  token_issued_at: string;
  token_expires_at: string | null;
  token_revoked_at: string | null;
  connection_epoch: number;
};

type Question = {
  id: string;
  session_id: string;
  question_text: string;
  submitted_at: string;
  processing_status:
    "queued" | "processing" | "completed" | "superseded" | "failed";
  sequence_number: number;
  processing_started_at: string | null;
  processing_finished_at: string | null;
  client_request_id: string | null;
  lease_id: string | null;
  lease_until: string | null;
  attempts: number;
  error_code: string | null;
  delivered_at: string | null;
};

type AnswerState = {
  session_id: string;
  latest_question_id: string | null;
  answer_text: string | null;
  readiness_status: "empty" | "pending" | "ready";
  updated_at: string;
};

type PreparedQa = {
  id: string;
  question: string;
  answer: string;
  alternative_questions: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
  search_vector: string | null;
  embedding: string | null;
  embedding_model: string | null;
  embedding_hash: string | null;
};

type ReferenceDocument = {
  id: string;
  original_filename: string;
  storage_bucket: string;
  storage_path: string;
  file_type: string;
  size_bytes: number | null;
  processing_status: "pending" | "processing" | "ready" | "failed";
  uploaded_at: string;
  updated_at: string;
  metadata: Json;
  error_code: string | null;
};

type DocumentChunk = {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  metadata: Json;
  created_at: string;
  updated_at: string;
  search_vector: string | null;
  embedding: string | null;
  embedding_model: string | null;
  embedding_hash: string | null;
};

export type Database = {
  public: {
    Tables: {
      sessions: Table<Session, "session_code">;
      session_participants: Table<
        Participant,
        "session_id" | "role" | "reconnect_token_hash"
      >;
      questions: Table<
        Question,
        "session_id" | "question_text",
        "sequence_number"
      >;
      session_answer_state: Table<AnswerState, "session_id">;
      prepared_qa: Table<PreparedQa, "question" | "answer">;
      reference_documents: Table<
        ReferenceDocument,
        "original_filename" | "storage_path" | "file_type"
      >;
      reference_document_chunks: Table<
        DocumentChunk,
        "document_id" | "content" | "chunk_index"
      >;
      relay_rate_limits: Table<
        { scope: string; window_started_at: string; request_count: number },
        "scope" | "window_started_at" | "request_count"
      >;
      prepared_question_variants: Table<
        {
          id: string;
          entry_id: string;
          normalized_text: string;
          fingerprint: string;
        },
        "entry_id" | "normalized_text",
        "fingerprint"
      >;
    };
    Views: Record<never, never>;
    Functions: {
      relay_rate_limit: {
        Args: { p_scope: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      relay_session_availability: {
        Args: Record<string, never>;
        Returns: Json;
      };
      relay_create_session: {
        Args: { p_code: string; p_token_hash: string };
        Returns: Json;
      };
      relay_join_session: {
        Args: { p_code: string; p_token_hash: string };
        Returns: Json;
      };
      relay_session_snapshot: {
        Args: { p_token_hash: string; p_role: string; p_heartbeat?: boolean };
        Returns: Json;
      };
      relay_quit_session: {
        Args: { p_token_hash: string; p_role: string };
        Returns: Json;
      };
      relay_submit_question: {
        Args: { p_token_hash: string; p_text: string; p_request_id: string };
        Returns: Json;
      };
      relay_claim_question: { Args: { p_session_id: string }; Returns: Json };
      relay_finish_question: {
        Args: {
          p_question_id: string;
          p_lease_id: string;
          p_answer: string | null;
          p_error_code?: string | null;
        };
        Returns: boolean;
      };
      relay_ack_answer: {
        Args: { p_token_hash: string; p_question_id: string };
        Returns: boolean;
      };
      relay_exact_answer: {
        Args: { p_question: string };
        Returns: { id: string; answer: string }[];
      };
      relay_search_prepared: {
        Args: {
          p_question: string;
          p_embedding?: string | null;
          p_model?: string | null;
        };
        Returns: {
          id: string;
          question: string;
          alternative_questions: string[];
          score: number;
        }[];
      };
      relay_search_chunks: {
        Args: {
          p_question: string;
          p_embedding?: string | null;
          p_model?: string | null;
        };
        Returns: {
          id: string;
          document_id: string;
          content: string;
          filename: string;
          score: number;
        }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
