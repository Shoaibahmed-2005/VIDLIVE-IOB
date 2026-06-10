--
-- PostgreSQL database dump
--

\restrict z1G0koEGzcXKEHkf7PD7PG8gLSaOZunQwUFX3B0k0cEe1I2rqLqZKRxXumOJ86J

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: customers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.customers (
    id integer NOT NULL,
    customer_id character varying(20) NOT NULL,
    full_name character varying(100) NOT NULL,
    phone_number character varying(15) NOT NULL,
    password_hash character varying(255) NOT NULL,
    account_number character varying(16) NOT NULL,
    balance numeric(15,2) NOT NULL,
    is_face_enrolled boolean NOT NULL,
    face_landmarks json,
    micro_expression_baseline json,
    reaction_time_baseline double precision,
    registered_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.customers OWNER TO postgres;

--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.customers_id_seq OWNER TO postgres;

--
-- Name: customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    transaction_id character varying(30) NOT NULL,
    sender_account character varying(30) NOT NULL,
    receiver_account character varying(30) NOT NULL,
    receiver_name character varying(100) NOT NULL,
    amount numeric(15,2) NOT NULL,
    remarks text,
    status character varying(10) NOT NULL,
    vidlive_required boolean NOT NULL,
    vidlive_passed boolean,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.transactions OWNER TO postgres;

--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.transactions_id_seq OWNER TO postgres;

--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- Name: vidlive_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.vidlive_sessions (
    id integer NOT NULL,
    session_id character varying(36) NOT NULL,
    customer_id character varying(20) NOT NULL,
    transaction_id character varying(30),
    is_enrollment boolean NOT NULL,
    step3_parallax_score double precision,
    step4_deepfake_score double precision,
    step5_reaction_ms double precision,
    step6_micro_expression_score double precision,
    final_trust_score double precision,
    result character varying(10),
    breakdown json,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.vidlive_sessions OWNER TO postgres;

--
-- Name: vidlive_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.vidlive_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.vidlive_sessions_id_seq OWNER TO postgres;

--
-- Name: vidlive_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.vidlive_sessions_id_seq OWNED BY public.vidlive_sessions.id;


--
-- Name: customers id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- Name: vidlive_sessions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vidlive_sessions ALTER COLUMN id SET DEFAULT nextval('public.vidlive_sessions_id_seq'::regclass);


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.customers (id, customer_id, full_name, phone_number, password_hash, account_number, balance, is_face_enrolled, face_landmarks, micro_expression_baseline, reaction_time_baseline, registered_at) FROM stdin;
2	IOB2024002	Rajesh Venkataraman	9876500001	$2b$12$gHsuHLO9OeF2iGSRb3vlXe18eWiA2BpGLQRCO3ooioi1HgriOxD/.	0057100000020002	2500000.00	f	\N	\N	\N	2026-05-18 12:53:43.383634+05:30
3	IOB2024003	Priya Sundaram	9876500002	$2b$12$esiYbHWxzV0dqbT6tiZRYOzI0d7PTWNX8jIScK7JD0qiuPkBc71Ae	0057100000030003	197000.00	f	\N	\N	\N	2026-05-18 12:53:43.383634+05:30
1	IOB2024001	Arjun Mehta	9876543210	$2b$12$HwcWNCIV3x/4k4r1yyx94u9cuZTe99BEBLy6hPcAISX3LJcaiT3BW	0057100000010001	138000.00	t	{"points": 468}	{"variance": 1.6}	340	2026-05-18 12:53:43.383634+05:30
\.


--
-- Data for Name: transactions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.transactions (id, transaction_id, sender_account, receiver_account, receiver_name, amount, remarks, status, vidlive_required, vidlive_passed, created_at) FROM stdin;
6	TXN20240001	EMPLOYER001	0057100000010001	Arjun Mehta	45000.00	Salary credit	approved	f	\N	2026-05-15 08:19:25.732007+05:30
7	TXN20240002	0057100000010001	TNEB000000000001	TNEB	1850.00	Electricity bill payment	approved	f	\N	2026-05-13 08:19:25.732007+05:30
8	TXN20240003	0057100000010001	0057100000030003	Priya Sundaram	8000.00	Fund transfer	approved	f	\N	2026-05-11 08:19:25.732007+05:30
9	TXN20240004	0057100000030003	0057100000010001	Arjun Mehta	12000.00	Payment received	approved	f	\N	2026-05-08 08:19:25.732007+05:30
10	TXN20240005	0057100000010001	AMAZON00000000001	Amazon	3200.00	Online purchase	approved	f	\N	2026-05-06 08:19:25.732007+05:30
11	TXN20240006	0057100000010001	SAVINGS000000001	Arjun Savings	5500.00	Transfer to savings	approved	f	\N	2026-05-03 08:19:25.732007+05:30
12	TXN202605180828562951	0057100000010001	0057100000030003	Priya Sundaram	500.00	Live test	approved	f	\N	2026-05-18 13:58:56.887842+05:30
13	TXN202605180830381891	0057100000010001	0057100000030003	Priya Sundaram	500.00	Phase2 test	approved	f	\N	2026-05-18 14:00:38.822955+05:30
14	TXN202605180830422120	0057100000010001	0057100000030003	Priya Sundaram	60000.00	high value	approved	t	t	2026-05-18 14:00:42.886362+05:30
15	TXN202605180840442918	0057100000010001	0057100000030003	Priya Sundaram	1000.00	verify phase2	approved	f	\N	2026-05-18 14:10:44.517928+05:30
16	TXN202605180840463186	0057100000010001	0057100000030003	Priya Sundaram	50000.00	exactly 50k	approved	t	t	2026-05-18 14:10:46.576472+05:30
\.


--
-- Data for Name: vidlive_sessions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.vidlive_sessions (id, session_id, customer_id, transaction_id, is_enrollment, step3_parallax_score, step4_deepfake_score, step5_reaction_ms, step6_micro_expression_score, final_trust_score, result, breakdown, created_at) FROM stdin;
1	3d86d115-ac92-4389-95f6-3184f32a7de1	IOB2024001	TXN202605180830422120	f	0.85	32.9	310	22	94.9	pass	{"step3_geometry": 15, "step4_deepfake": 32.9, "step5_reaction": 25, "step6_micro": 22.0}	2026-05-18 14:00:44.928442+05:30
2	7e27e118-f31f-4bb2-943a-9cd58c3b79db	IOB2024001	TXN202605180840463186	f	0.85	32.9	310	22	94.9	pass	{"step3_geometry": 15, "step4_deepfake": 32.9, "step5_reaction": 25, "step6_micro": 22.0}	2026-05-18 14:10:56.767543+05:30
3	f056cebf-fdfb-4a35-87d1-98be7778207c	IOB2024001	\N	t	\N	\N	\N	\N	\N	\N	\N	2026-05-18 14:11:02.90737+05:30
\.


--
-- Name: customers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.customers_id_seq', 3, true);


--
-- Name: transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.transactions_id_seq', 16, true);


--
-- Name: vidlive_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.vidlive_sessions_id_seq', 3, true);


--
-- Name: customers customers_account_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_account_number_key UNIQUE (account_number);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: vidlive_sessions vidlive_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vidlive_sessions
    ADD CONSTRAINT vidlive_sessions_pkey PRIMARY KEY (id);


--
-- Name: ix_customers_customer_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ix_customers_customer_id ON public.customers USING btree (customer_id);


--
-- Name: ix_customers_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ix_customers_id ON public.customers USING btree (id);


--
-- Name: ix_transactions_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ix_transactions_id ON public.transactions USING btree (id);


--
-- Name: ix_transactions_transaction_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ix_transactions_transaction_id ON public.transactions USING btree (transaction_id);


--
-- Name: ix_vidlive_sessions_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ix_vidlive_sessions_id ON public.vidlive_sessions USING btree (id);


--
-- Name: ix_vidlive_sessions_session_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX ix_vidlive_sessions_session_id ON public.vidlive_sessions USING btree (session_id);


--
-- PostgreSQL database dump complete
--

\unrestrict z1G0koEGzcXKEHkf7PD7PG8gLSaOZunQwUFX3B0k0cEe1I2rqLqZKRxXumOJ86J

