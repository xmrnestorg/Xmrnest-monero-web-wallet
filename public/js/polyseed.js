/**
 * Polyseed (16-word Monero seed, https://github.com/tevador/polyseed) decoder for the browser.
 *
 * Port of the reference C implementation (polyseed.c / gf.c / storage.c / lang.c, English
 * wordlist only). A Polyseed embeds the wallet's creation month ("birthday"), so the restore
 * height can be derived without asking the user. Encrypted (passphrase) seeds are detected
 * and rejected. Key derivation is PBKDF2-HMAC-SHA256 (10000 rounds) via WebCrypto; the
 * 32-byte output is the raw spend key material. The caller must reduce it modulo the curve
 * order (cnUtil.sc_reduce32) BEFORE cnUtil.create_address, exactly as wallet2 does, because
 * create_address derives the view key from the bytes it is given.
 */
(function(window) {
    'use strict';

    var NUM_WORDS = 16;
    var GF_BITS = 11;
    var GF_MASK = (1 << GF_BITS) - 1;
    var SECRET_BITS = 150;
    var SECRET_SIZE = 19;
    var SECRET_BUFFER_SIZE = 32;
    var DATE_BITS = 10;
    var DATE_MASK = (1 << DATE_BITS) - 1;
    var FEATURE_BITS = 5;
    var FEATURE_MASK = (1 << FEATURE_BITS) - 1;
    var ENCRYPTED_MASK = 16;
    var EPOCH = 1635768000;      // 1 November 2021 12:00 UTC
    var TIME_STEP = 2629746;     // 1/12 of a Gregorian year, in seconds
    var KDF_ITERATIONS = 10000;
    var COIN_MONERO = 0;
    var PREFIX_LEN = 4;
    var MUL2_TABLE = [5, 7, 1, 3, 13, 15, 9, 11];

    var WORDS = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","huge","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];

    function gfMul2(x) {
        if (x < 1024) return 2 * x;
        return MUL2_TABLE[x % 8] + 16 * Math.floor((x - 1024) / 8);
    }

    function gfPolyEval(coeff) {
        var result = coeff[NUM_WORDS - 1];
        for (var i = NUM_WORDS - 2; i >= 0; i--) {
            result = gfMul2(result) ^ coeff[i];
        }
        return result;
    }

    /**
     * Reference matching rule (compare_prefix with n=4): a typed word matches a dictionary
     * word when all its characters match the start of that word and it is at least 4
     * characters long, or when it equals the whole word.
     */
    function findWord(key) {
        if (!key) return -1;
        if (key.length < PREFIX_LEN) {
            var exact = WORDS.indexOf(key);
            return exact;
        }
        var lo = 0, hi = WORDS.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            var w = WORDS[mid];
            if (w.indexOf(key) === 0) return mid;
            if (key < w) hi = mid - 1; else lo = mid + 1;
        }
        return -1;
    }

    function polyToData(coeff) {
        var secret = new Uint8Array(SECRET_SIZE);
        var extraVal = 0, extraBits = 0;
        var secretIdx = 0, secretBits = 0, seedBits = 0;
        for (var i = 1; i < NUM_WORDS; i++) {
            var wordVal = coeff[i];
            extraVal = (extraVal << 1) | (wordVal & 1);
            wordVal >>= 1;
            var wordBits = GF_BITS - 1;
            extraBits++;
            while (wordBits > 0) {
                if (secretBits === 8) {
                    secretIdx++;
                    seedBits += secretBits;
                    secretBits = 0;
                }
                var chunkBits = Math.min(wordBits, 8 - secretBits);
                wordBits -= chunkBits;
                var chunkMask = (1 << chunkBits) - 1;
                if (chunkBits < 8) secret[secretIdx] = (secret[secretIdx] << chunkBits) & 0xff;
                secret[secretIdx] |= (wordVal >> wordBits) & chunkMask;
                secretBits += chunkBits;
            }
        }
        seedBits += secretBits;
        if (seedBits !== SECRET_BITS || extraBits !== FEATURE_BITS + DATE_BITS) {
            throw new Error('Polyseed: internal decode error');
        }
        return {
            secret: secret,
            birthday: extraVal & DATE_MASK,
            features: extraVal >> DATE_BITS,
            checksum: coeff[0]
        };
    }

    function toHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
        return s;
    }

    function le32(n) {
        return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    }

    var Polyseed = {
        WORDS: WORDS,

        /** True when the phrase has exactly 16 words (so it should be treated as Polyseed). */
        looksLikePolyseed: function(phrase) {
            return String(phrase || '').trim().split(/\s+/).filter(Boolean).length === NUM_WORDS;
        },

        /**
         * Decode a 16-word phrase. Throws with a human-readable message on any error.
         * @returns {{ secretHex, birthday, birthdayTs, birthdayDate, features, encrypted, checksum }}
         */
        decode: function(phrase, coin) {
            coin = typeof coin === 'number' ? coin : COIN_MONERO;
            var words = String(phrase || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (words.length !== NUM_WORDS) {
                throw new Error('A Polyseed has exactly 16 words (' + words.length + ' given).');
            }
            var coeff = new Array(NUM_WORDS);
            for (var i = 0; i < NUM_WORDS; i++) {
                var idx = findWord(words[i]);
                if (idx < 0) {
                    throw new Error('Word ' + (i + 1) + ' ("' + words[i] + '") is not in the Polyseed English wordlist.');
                }
                coeff[i] = idx;
            }
            coeff[1] ^= coin;
            if (gfPolyEval(coeff) !== 0) {
                throw new Error('Polyseed checksum failed: one or more words are wrong or out of order.');
            }
            var data = polyToData(coeff);
            if ((data.features & (FEATURE_MASK ^ ENCRYPTED_MASK)) !== 0) {
                throw new Error('This Polyseed uses features this wallet does not support.');
            }
            var birthdayTs = EPOCH + data.birthday * TIME_STEP;
            var d = new Date(birthdayTs * 1000);
            var birthdayDate = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
            return {
                secretHex: toHex(data.secret),
                birthday: data.birthday,
                birthdayTs: birthdayTs,
                birthdayDate: birthdayDate,
                features: data.features,
                encrypted: (data.features & ENCRYPTED_MASK) !== 0,
                checksum: data.checksum
            };
        },

        /**
         * Derive the 32-byte key (hex) from a decoded seed: PBKDF2-HMAC-SHA256 over the
         * zero-padded secret with the reference salt layout.
         */
        deriveKey: async function(decoded, coin) {
            coin = typeof coin === 'number' ? coin : COIN_MONERO;
            if (decoded.encrypted) {
                throw new Error('Encrypted Polyseed phrases (with a passphrase) are not supported here.');
            }
            var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
            if (!subtle) throw new Error('WebCrypto is required to derive a Polyseed key.');

            var pw = new Uint8Array(SECRET_BUFFER_SIZE);
            for (var i = 0; i < SECRET_SIZE; i++) pw[i] = parseInt(decoded.secretHex.substr(i * 2, 2), 16);

            var salt = new Uint8Array(32);
            var label = 'POLYSEED key';
            for (var j = 0; j < label.length; j++) salt[j] = label.charCodeAt(j);
            salt[12] = 0; salt[13] = 0xff; salt[14] = 0xff; salt[15] = 0xff;
            salt.set(le32(coin), 16);
            salt.set(le32(decoded.birthday), 20);
            salt.set(le32(decoded.features), 24);

            var keyMaterial = await subtle.importKey('raw', pw, { name: 'PBKDF2' }, false, ['deriveBits']);
            var bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: KDF_ITERATIONS }, keyMaterial, 256);
            return toHex(new Uint8Array(bits));
        },

        _debug: { pwSaltHex: function(decoded) {
            var pw = new Uint8Array(SECRET_BUFFER_SIZE);
            for (var i = 0; i < SECRET_SIZE; i++) pw[i] = parseInt(decoded.secretHex.substr(i * 2, 2), 16);
            var salt = new Uint8Array(32); var label = 'POLYSEED key';
            for (var j = 0; j < label.length; j++) salt[j] = label.charCodeAt(j);
            salt[13] = 0xff; salt[14] = 0xff; salt[15] = 0xff;
            salt.set(le32(0), 16); salt.set(le32(decoded.birthday), 20); salt.set(le32(decoded.features), 24);
            return { pw: toHex(pw), salt: toHex(salt) };
        } }
    };

    window.Polyseed = Polyseed;
})(window);
