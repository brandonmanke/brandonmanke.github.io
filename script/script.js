//TODO: add noscript tags
;(function() {
    window.onload = function() {
        setTimeout(function() {
            document.querySelector('.background').className += ' show'
        }, 500)
        setTimeout(function() {
            document.querySelector('.title').className += ' show'
        }, 900)
        setTimeout(function() {
            document.querySelector('.about').className += ' show'
            document.querySelector('.projects').className += ' show'
        }, 900)
    }
})(this)
