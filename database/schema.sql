-- Esquema de kyc_db (kyc-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    staff_role character varying,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kyc_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kyc_records (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    nombres character varying NOT NULL,
    apellidos character varying NOT NULL,
    tipo_documento character varying NOT NULL,
    numero_documento character varying NOT NULL,
    numero_documento_hash character varying(64),
    fecha_nacimiento character varying NOT NULL,
    fecha_expedicion character varying NOT NULL,
    email character varying,
    telefono character varying,
    telefono_hash character varying(64),
    status character varying DEFAULT 'verified'::character varying NOT NULL,
    submission_token_hash character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    rejection_code character varying(40),
    rejection_message character varying(300),
    reviewed_by character varying,
    reviewed_by_role character varying,
    review_reason character varying(300),
    reviewed_at timestamp with time zone
);


--
-- Name: kyc_records PK_116991f893d637ee173b9de8ed0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_records
    ADD CONSTRAINT "PK_116991f893d637ee173b9de8ed0" PRIMARY KEY (id);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: event_outbox PK_c8bd4a6797caa3ebad9b40c9813; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT "PK_c8bd4a6797caa3ebad9b40c9813" PRIMARY KEY (id);


--
-- Name: IDX_41fbd4f89da58040c8ac6857d8; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_41fbd4f89da58040c8ac6857d8" ON public.kyc_records USING btree (telefono_hash);


--
-- Name: IDX_8496315400dcd77d61c34093fd; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_8496315400dcd77d61c34093fd" ON public.kyc_records USING btree (id_user);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_d35215a6bdd3a72a325d296566; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_d35215a6bdd3a72a325d296566" ON public.kyc_records USING btree (numero_documento_hash);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_event_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_outbox_pending ON public.event_outbox USING btree (published_at, created_at);


--
-- PostgreSQL database dump complete
--


